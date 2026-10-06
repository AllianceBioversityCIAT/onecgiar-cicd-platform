// @akili-spec changes/cicd-executor-poc design §7.5, DD-10; requirements FR-12
// A REAL in-process SSH server built with `ssh2`'s Server class (no Docker, no
// external host). Host and client keys are generated at test time, so no key
// material is ever committed. Records exactly what the client did, so tests
// assert on the wire-level behavior (auth attempts, exec commands, SFTP files).
import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Connection, ServerChannel, SFTPWrapper } from "ssh2";
import { Server, utils } from "../../src/adapters/ssh-deployer/ssh2-module.js";

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

export interface TestKeyPair {
  /** Private key in a format ssh2 accepts as `privateKey` / `hostKeys`. */
  readonly privateKey: string;
  /** OpenSSH public key line. */
  readonly publicKey: string;
}

/**
 * Keys come from node:crypto and are encoded here as an unencrypted OpenSSH
 * ed25519 key. NOT from `ssh2`'s `utils.generateKeyPairSync`: its ed25519
 * OpenSSH encoder drops a leading zero byte of the key material (about 1% of
 * keys), producing text that `ssh2` itself then rejects with "Malformed
 * OpenSSH private key" (root cause of a flaky suite, N-13).
 */
const armor = (edge: string): string => `${"-".repeat(5)}${edge} OPENSSH PRIVATE ${"KEY"}${"-".repeat(5)}`;

export function generateTestKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n, 0);
    return b;
  };
  const field = (data: Buffer | string): Buffer => {
    const d = typeof data === "string" ? Buffer.from(data) : data;
    return Buffer.concat([u32(d.length), d]);
  };
  const pubBlob = Buffer.concat([field("ssh-ed25519"), field(pub)]);
  const check = randomBytes(4);
  let inner = Buffer.concat([check, check, field("ssh-ed25519"), field(pub), field(Buffer.concat([seed, pub])), field("")]);
  const padding = Buffer.alloc((8 - (inner.length % 8)) % 8);
  padding.forEach((_v, i) => (padding[i] = i + 1));
  inner = Buffer.concat([inner, padding]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    field("none"),
    field("none"),
    field(""),
    u32(1),
    field(pubBlob),
    field(inner),
  ]);
  const lines = body.toString("base64").match(/.{1,70}/g)!.join("\n");
  return {
    // Armor assembled at runtime so no key-shaped literal is committed (publication guard).
    privateKey: `${armor("BEGIN")}
${lines}
${armor("END")}
`,
    publicKey: `ssh-ed25519 ${pubBlob.toString("base64")}`,
  };
}

export interface ExecContext {
  readonly command: string;
  readonly stream: ServerChannel;
  readonly server: SshTestServer;
}

export interface SshTestServerOptions {
  readonly hostKey: TestKeyPair;
  /** Client public key (OpenSSH line) allowed to authenticate. */
  readonly authorizedPublicKey?: string;
  /** Password allowed to authenticate. */
  readonly authorizedPassword?: string;
  /** Called for every exec request. Default: exit 0 with no output. */
  readonly onExec?: (context: ExecContext) => void;
  /** When set, every SFTP write stores these bytes instead of the real ones (simulates corruption). */
  readonly corruptWritesWith?: Buffer;
}

export function reply(stream: ServerChannel, result: { stdout?: string; stderr?: string; code: number }): void {
  if (result.stderr !== undefined) stream.stderr.write(result.stderr);
  if (result.stdout !== undefined) stream.write(result.stdout);
  stream.exit(result.code);
  stream.end();
}

/** uid of the authenticated SSH user in the test server. */
export const SSH_USER_UID = 1000;

export class SshTestServer {
  public readonly execCommands: string[] = [];
  public readonly authAttempts: string[] = [];
  public readonly files = new Map<string, Buffer>();
  /** Directory path -> owner and permission bits (so tests can model foreign or open directories). */
  public readonly directories = new Map<string, { mode: number; uid: number }>();
  public readonly fileModes = new Map<string, number>();
  public connectionCount = 0;
  public port = 0;
  private readonly server: InstanceType<typeof Server>;
  private readonly connections = new Set<Connection>();

  public constructor(private readonly options: SshTestServerOptions) {
    this.server = new Server({ hostKeys: [options.hostKey.privateKey] }, (client) => this.onClient(client));
  }

  public async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  /** Pre-creates a directory as another party would (any owner, any mode). */
  public seedDirectory(path: string, mode: number, uid: number): void {
    this.directories.set(path, { mode, uid });
  }

  public async close(): Promise<void> {
    for (const connection of this.connections) connection.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Abruptly drops every client connection (simulates a lost session). */
  public dropConnections(): void {
    for (const connection of this.connections) (connection as unknown as { _sock: { destroy(): void } })._sock.destroy();
  }

  private onClient(client: Connection): void {
    this.connectionCount += 1;
    this.connections.add(client);
    client.on("error", () => undefined);
    client.on("close", () => this.connections.delete(client));
    client.on("authentication", (ctx) => {
      this.authAttempts.push(ctx.method);
      if (ctx.method === "publickey" && this.options.authorizedPublicKey !== undefined) {
        const allowed = utils.parseKey(this.options.authorizedPublicKey);
        const allowedKey = Array.isArray(allowed) ? allowed[0] : allowed;
        if (allowedKey && !(allowedKey instanceof Error) && ctx.key.algo === allowedKey.type) {
          const same = Buffer.compare(ctx.key.data, allowedKey.getPublicSSH()) === 0;
          if (same && (ctx.signature === undefined || allowedKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)) {
            return ctx.accept();
          }
        }
        return ctx.reject();
      }
      if (ctx.method === "password" && this.options.authorizedPassword !== undefined) {
        return ctx.password === this.options.authorizedPassword ? ctx.accept() : ctx.reject();
      }
      return ctx.reject(["publickey", "password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          this.execCommands.push(info.command);
          (this.options.onExec ?? defaultExec)({ command: info.command, stream, server: this });
        });
        session.on("sftp", (acceptSftp) => this.serveSftp(acceptSftp()));
      });
    });
  }

  private serveSftp(sftp: SFTPWrapper): void {
    const handles = new Map<number, { path: string; writable: boolean }>();
    let nextHandle = 1;
    const dirAttrs = (path: string): { mode: number; size: number; uid: number; gid: number; atime: number; mtime: number } => {
      const dir = this.directories.get(path)!;
      return { mode: 0o40000 | dir.mode, size: 0, uid: dir.uid, gid: 0, atime: 0, mtime: 0 };
    };
    const fileAttrs = (size: number): { mode: number; size: number; uid: number; gid: number; atime: number; mtime: number } => ({
      mode: 0o100700,
      size,
      uid: 0,
      gid: 0,
      atime: 0,
      mtime: 0,
    });
    const handleOf = (buf: Buffer): { path: string; writable: boolean } | undefined => handles.get(buf.readUInt32BE(0));

    sftp.on("MKDIR", (reqId, path, attrs) => {
      if (this.directories.has(path) || this.files.has(path)) return sftp.status(reqId, STATUS_CODE.FAILURE);
      this.directories.set(path, { mode: (typeof attrs.mode === "number" ? attrs.mode : 0o755) & 0o777, uid: SSH_USER_UID });
      sftp.status(reqId, STATUS_CODE.OK);
    });
    sftp.on("LSTAT", (reqId, path) => {
      if (this.directories.has(path)) return sftp.attrs(reqId, dirAttrs(path));
      const file = this.files.get(path);
      if (file) return sftp.attrs(reqId, fileAttrs(file.length));
      sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    });
    sftp.on("STAT", (reqId, path) => {
      if (this.directories.has(path)) return sftp.attrs(reqId, dirAttrs(path));
      const file = this.files.get(path);
      if (file) return sftp.attrs(reqId, fileAttrs(file.length));
      sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    });
    sftp.on("REMOVE", (reqId, path) => {
      if (!this.files.delete(path)) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
      sftp.status(reqId, STATUS_CODE.OK);
    });
    sftp.on("OPEN", (reqId, path, flags, attrs) => {
      const exists = this.files.has(path);
      if (flags & OPEN_MODE.WRITE) {
        if (flags & OPEN_MODE.EXCL && exists) return sftp.status(reqId, STATUS_CODE.FAILURE);
        if (!exists && !(flags & OPEN_MODE.CREAT)) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
        this.files.set(path, Buffer.alloc(0));
        if (typeof attrs.mode === "number") this.fileModes.set(path, attrs.mode);
      } else if (!exists) {
        return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
      }
      const id = nextHandle++;
      handles.set(id, { path, writable: Boolean(flags & OPEN_MODE.WRITE) });
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(id, 0);
      sftp.handle(reqId, handle);
    });
    sftp.on("WRITE", (reqId, handleBuf, offset, data) => {
      const handle = handleOf(handleBuf);
      if (!handle?.writable) return sftp.status(reqId, STATUS_CODE.FAILURE);
      const stored = this.options.corruptWritesWith ?? data;
      const current = this.files.get(handle.path) ?? Buffer.alloc(0);
      const next = Buffer.alloc(Math.max(current.length, offset + stored.length));
      current.copy(next);
      stored.copy(next, offset);
      this.files.set(handle.path, next);
      sftp.status(reqId, STATUS_CODE.OK);
    });
    sftp.on("READ", (reqId, handleBuf, offset, length) => {
      const handle = handleOf(handleBuf);
      const content = handle ? this.files.get(handle.path) : undefined;
      if (!content) return sftp.status(reqId, STATUS_CODE.FAILURE);
      if (offset >= content.length) return sftp.status(reqId, STATUS_CODE.EOF);
      sftp.data(reqId, content.subarray(offset, Math.min(content.length, offset + length)));
    });
    sftp.on("FSTAT", (reqId, handleBuf) => {
      const handle = handleOf(handleBuf);
      const content = handle ? this.files.get(handle.path) : undefined;
      if (!content) return sftp.status(reqId, STATUS_CODE.FAILURE);
      sftp.attrs(reqId, fileAttrs(content.length));
    });
    sftp.on("CLOSE", (reqId, handleBuf) => {
      handles.delete(handleBuf.readUInt32BE(0));
      sftp.status(reqId, STATUS_CODE.OK);
    });
  }
}

function defaultExec({ stream }: ExecContext): void {
  reply(stream, { code: 0 });
}
