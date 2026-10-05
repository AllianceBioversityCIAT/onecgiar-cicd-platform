// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §4.2
//
// Proves the boundary scanner itself can fail: one negative fixture per
// rule, each a full (but minimal) Dockerfile whose final stage contains
// exactly the forbidden element a prior single-regex guard missed (see T-01
// attempt 1 review). A rule with no fixture here is not evidence it works.

import { describe, expect, it } from "vitest";
import { scanFinalStage, splitStages, finalStage } from "../support/dockerfile-boundary-scanner.js";

/** A clean final stage: non-root user, npm/npx/corepack/yarn fully removed, nothing forbidden. */
const CLEAN_RUNTIME_TAIL = `
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
USER executor
`;

function dockerfile(finalStageBody: string): string {
  return `
FROM node:22-slim AS builder
WORKDIR /build
RUN npm ci
RUN npm run build

${finalStageBody}
`;
}

describe("scanFinalStage — positive control", () => {
  it("reports zero violations for a clean final stage", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text)).toEqual([]);
  });
});

describe("scanFinalStage — image reference denylist", () => {
  it("goes red on FROM docker:27-cli as the final stage", () => {
    const text = dockerfile(`FROM docker:27-cli AS runtime\n${CLEAN_RUNTIME_TAIL}`);
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule.startsWith("forbidden-image:"))).toBe(true);
  });

  it("goes red on COPY --from=docker:cli (binary smuggled from a docker image)", () => {
    const text = dockerfile(
      `FROM node:22-slim AS runtime\nCOPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/\n${CLEAN_RUNTIME_TAIL}`,
    );
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule.startsWith("forbidden-image:"))).toBe(true);
  });

  it("does NOT flag COPY --from=builder (a real local stage name)", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nCOPY --from=builder /build/dist ./dist\n${CLEAN_RUNTIME_TAIL}`);
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule.startsWith("forbidden-image:"))).toBe(false);
  });

  it("goes red on a maven/gradle/openjdk/python final base image", () => {
    for (const image of ["maven:3-eclipse-temurin-21", "gradle:8-jdk21", "eclipse-temurin:21", "python:3.12-slim"]) {
      const text = dockerfile(`FROM ${image} AS runtime\n${CLEAN_RUNTIME_TAIL}`);
      const violations = scanFinalStage(text);
      expect(violations.some((v) => v.rule.startsWith("forbidden-image:"))).toBe(true);
    }
  });
});

describe("scanFinalStage — forbidden package installs", () => {
  it("goes red on apk add docker (bare package name)", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN apk add docker\n${CLEAN_RUNTIME_TAIL}`);
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule === "forbidden-package:docker package")).toBe(true);
  });

  it("goes red on default-jdk / temurin JDK packages (not just openjdk)", () => {
    for (const pkg of ["default-jdk", "temurin-17-jdk", "java-17-openjdk"]) {
      const text = dockerfile(`FROM node:22-slim AS runtime\nRUN apt-get install -y ${pkg}\n${CLEAN_RUNTIME_TAIL}`);
      const violations = scanFinalStage(text);
      expect(violations.some((v) => v.rule === "forbidden-package:JDK package")).toBe(true);
    }
  });

  it("goes red on openjdk (regression: original rule)", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN apt-get install -y openjdk-17-jre\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule === "forbidden-package:JDK package")).toBe(true);
  });

  it("goes red on python3-pip", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN apt-get install -y python3-pip\n${CLEAN_RUNTIME_TAIL}`);
    expect(
      scanFinalStage(text).some((v) => v.rule === "forbidden-package:python build toolchain package"),
    ).toBe(true);
  });

  it("goes red on maven/mvn and gradle (regression: original rule)", () => {
    const mavenText = dockerfile(`FROM node:22-slim AS runtime\nRUN apt-get install -y maven\n${CLEAN_RUNTIME_TAIL}`);
    const gradleText = dockerfile(`FROM node:22-slim AS runtime\nRUN apt-get install -y gradle\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(mavenText).some((v) => v.rule === "forbidden-package:maven package")).toBe(true);
    expect(scanFinalStage(gradleText).some((v) => v.rule === "forbidden-package:gradle package")).toBe(true);
  });
});

describe("scanFinalStage — remote installer scripts and docker.sock", () => {
  it("goes red on curl get.docker.com | sh", () => {
    const text = dockerfile(
      `FROM node:22-slim AS runtime\nRUN curl -fsSL https://get.docker.com | sh\n${CLEAN_RUNTIME_TAIL}`,
    );
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule === "remote-docker-installer")).toBe(true);
    expect(violations.some((v) => v.rule === "piped-remote-script")).toBe(true);
  });

  it("goes red on any curl/wget piped straight into a shell", () => {
    const text = dockerfile(
      `FROM node:22-slim AS runtime\nRUN wget -qO- https://example.invalid/install.sh | bash\n${CLEAN_RUNTIME_TAIL}`,
    );
    expect(scanFinalStage(text).some((v) => v.rule === "piped-remote-script")).toBe(true);
  });

  it("goes red on a mounted/referenced docker.sock", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nVOLUME /var/run/docker.sock\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule === "docker-socket-reference")).toBe(true);
  });

  it("goes red on pip install", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN pip install requests\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule === "pip-install")).toBe(true);
  });
});

describe("scanFinalStage — Node package manager invocation", () => {
  it("goes red on npm ci/install run in the final stage", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN npm ci --omit=dev\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule === "node-package-manager-invocation:npm")).toBe(true);
  });

  it("goes red on pnpm/yarn/corepack invocation in the final stage", () => {
    for (const cmd of ["pnpm install", "yarn global add foo", "corepack enable"]) {
      const bin = cmd.split(" ")[0];
      const text = dockerfile(`FROM node:22-slim AS runtime\nRUN ${cmd}\n${CLEAN_RUNTIME_TAIL}`);
      expect(scanFinalStage(text).some((v) => v.rule === `node-package-manager-invocation:${bin}`)).toBe(true);
    }
  });

  it("does NOT flag `rm -rf .../npm` as an npm invocation", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule.startsWith("node-package-manager-invocation"))).toBe(false);
  });
});

describe("scanFinalStage — npm/corepack removal required on node base images", () => {
  it("goes red when a node-based final stage never removes npm", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nUSER executor\n`);
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule === "npm-not-removed")).toBe(true);
    expect(violations.some((v) => v.rule === "corepack-not-removed")).toBe(true);
  });

  it("stays green once npm and corepack are both removed", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\n${CLEAN_RUNTIME_TAIL}`);
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule === "npm-not-removed" || v.rule === "corepack-not-removed")).toBe(false);
  });
});

describe("scanFinalStage — non-root user", () => {
  it("goes red on USER 0", () => {
    const text = dockerfile(
      `FROM node:22-slim AS runtime\nRUN rm -rf /usr/local/bin/npm /usr/local/bin/corepack\nUSER 0\n`,
    );
    expect(scanFinalStage(text).some((v) => v.rule === "root-user")).toBe(true);
  });

  it("goes red on USER root:root", () => {
    const text = dockerfile(
      `FROM node:22-slim AS runtime\nRUN rm -rf /usr/local/bin/npm /usr/local/bin/corepack\nUSER root:root\n`,
    );
    expect(scanFinalStage(text).some((v) => v.rule === "root-user")).toBe(true);
  });

  it("goes red when the final stage never declares a USER", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN rm -rf /usr/local/bin/npm /usr/local/bin/corepack\n`);
    expect(scanFinalStage(text).some((v) => v.rule === "no-user-instruction")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-01 attempt 2 review regressions. Each block below reproduces a bypass the
// reviewer found against the attempt-2 scanner (quoted in the review) as a
// red fixture, proving it now fails; a companion green fixture proves the
// rule does not false-positive on an equivalent clean construct.
// ---------------------------------------------------------------------------

describe("scanFinalStage — issue 1: COPY --from stage-alias smuggling", () => {
  it("goes red on COPY --from=<local stage> whose own base is a forbidden image", () => {
    const text = `
FROM node:22-slim AS builder
RUN npm ci
RUN npm run build

FROM docker:27-cli AS tools

FROM node:22-slim AS runtime
COPY --from=tools /usr/local/bin/ /usr/local/bin/
${CLEAN_RUNTIME_TAIL}
`;
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule.startsWith("forbidden-image:"))).toBe(true);
  });

  it("does NOT flag COPY --from=<local stage> whose own base is a plain node image", () => {
    const text = `
FROM node:22-slim AS builder
RUN npm ci
RUN npm run build

FROM node:22-slim AS runtime
COPY --from=builder /build/dist ./dist
${CLEAN_RUNTIME_TAIL}
`;
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule.startsWith("forbidden-image:"))).toBe(false);
  });

  it("goes red on FROM --platform=... <image> (the platform flag no longer swallows the image name)", () => {
    const text = `
FROM --platform=linux/amd64 docker:27-cli AS runtime
${CLEAN_RUNTIME_TAIL}
`;
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule.startsWith("forbidden-image:"))).toBe(true);
  });

  it("fails closed on an unresolved ARG/${...} base image instead of silently passing", () => {
    const text = `
ARG IMG=docker:27-cli
FROM \${IMG} AS runtime
${CLEAN_RUNTIME_TAIL}
`;
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule === "unresolved-base-image")).toBe(true);
  });

  it("fails closed on COPY --from=${STAGE} with an unresolved variable", () => {
    const text = `
FROM node:22-slim AS builder
RUN npm ci

FROM node:22-slim AS runtime
COPY --from=\${STAGE} /build/dist ./dist
${CLEAN_RUNTIME_TAIL}
`;
    expect(scanFinalStage(text).some((v) => v.rule === "unresolved-base-image")).toBe(true);
  });
});

describe("scanFinalStage — issue 2: final stage aliasing a local (npm-bearing) stage", () => {
  it("goes red when `FROM builder AS runtime` inherits builder's un-removed npm/corepack", () => {
    const text = `
FROM node:22-slim AS builder
RUN npm ci
RUN npm run build

FROM builder AS runtime
USER executor
`;
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule === "npm-not-removed")).toBe(true);
    expect(violations.some((v) => v.rule === "corepack-not-removed")).toBe(true);
  });

  it("stays green when the aliased ancestor stage itself removed npm/npx/corepack/yarn", () => {
    const text = `
FROM node:22-slim AS builder
RUN npm ci
RUN npm run build
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

FROM builder AS runtime
USER executor
`;
    const violations = scanFinalStage(text);
    const removalRules = ["npm-not-removed", "npx-not-removed", "corepack-not-removed", "yarn-not-removed"];
    expect(violations.some((v) => removalRules.includes(v.rule))).toBe(false);
  });
});

describe("scanFinalStage — issue 3: multiple USER instructions, last one wins", () => {
  it("goes red when a later USER switches back to root", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\n${CLEAN_RUNTIME_TAIL}\nUSER root\n`);
    expect(scanFinalStage(text).some((v) => v.rule === "root-user")).toBe(true);
  });

  it("stays green when a later USER switches away from an earlier root", () => {
    const tailWithRootFirst = CLEAN_RUNTIME_TAIL.replace("USER executor", "USER root\nUSER executor");
    const text = dockerfile(`FROM node:22-slim AS runtime\n${tailWithRootFirst}`);
    expect(scanFinalStage(text).some((v) => v.rule === "root-user")).toBe(false);
  });
});

describe("scanFinalStage — issue 4: package-manager invocation normalization", () => {
  it("goes red on an env-assignment-prefixed npm invocation (NODE_ENV=production npm ci)", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN NODE_ENV=production npm ci\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule === "node-package-manager-invocation:npm")).toBe(true);
  });

  it("goes red on an absolute-path npm invocation (/usr/local/bin/npm ci)", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN /usr/local/bin/npm ci\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule === "node-package-manager-invocation:npm")).toBe(true);
  });

  it('goes red on exec-form npm (RUN ["npm","ci"])', () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN ["npm","ci"]\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule === "node-package-manager-invocation:npm")).toBe(true);
  });

  it("goes red on npx invocation (npx was missing from the binary list)", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN npx something\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule === "node-package-manager-invocation:npx")).toBe(true);
  });

  it("does NOT accept a cache-directory cleanup as npm/corepack removal", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\nRUN rm -rf /root/.npm /tmp/corepack-cache\nUSER executor\n`);
    const violations = scanFinalStage(text);
    expect(violations.some((v) => v.rule === "npm-not-removed")).toBe(true);
    expect(violations.some((v) => v.rule === "corepack-not-removed")).toBe(true);
  });
});

describe("scanFinalStage — issue 5: yarn under /opt survives symlink-only removal", () => {
  it("goes red when only the /usr/local/bin yarn symlinks are removed, not /opt/yarn-*", () => {
    const text = dockerfile(
      `FROM node:22-slim AS runtime\nRUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg\nUSER executor\n`,
    );
    expect(scanFinalStage(text).some((v) => v.rule === "yarn-not-removed")).toBe(true);
  });

  it("stays green once /opt/yarn-* is also removed", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\n${CLEAN_RUNTIME_TAIL}`);
    expect(scanFinalStage(text).some((v) => v.rule === "yarn-not-removed")).toBe(false);
  });
});

describe("finalStage", () => {
  it("throws when the Dockerfile has no FROM instruction", () => {
    expect(() => finalStage("# just a comment\n")).toThrow();
  });

  it("returns the last stage's name and base image", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\n${CLEAN_RUNTIME_TAIL}`);
    const stage = finalStage(text);
    expect(stage.name).toBe("runtime");
    expect(stage.baseImage).toBe("node:22-slim");
  });
});

describe("splitStages", () => {
  it("counts each FROM as a separate stage", () => {
    const text = dockerfile(`FROM node:22-slim AS runtime\n${CLEAN_RUNTIME_TAIL}`);
    // builder (from the dockerfile() helper) + runtime
    expect(splitStages(text).length).toBe(2);
  });
});
