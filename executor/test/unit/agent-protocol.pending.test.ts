// @akili-spec changes/cicd-executor-poc architecture-change-04 §8, §9, §10, §16, §23
//
// Acceptance cases defined in E1. The E2 cases run in test/integration/agent-transport.int.test.ts and
// test/unit/agent-transport.test.ts; the E3 cases run in test/unit/agent.test.ts (real child processes and state
// directory) and test/emulator/agent-*.emulator.test.ts (the real agent process and SQS adapter on ElasticMQ). What
// remains needs real SQS and a Linux host and is verified at E5.
import { describe, it } from "vitest";

describe("E5 (real AWS and a Linux host)", () => {
  it.todo("the real SQS SenderId of the Executor role on a command and of the agent role on an event");
  it.todo("FIFO group delivery on Amazon SQS: a command waiting for a slot holds only its own target's group");
  it.todo("sudo -n with the catalog sudoers rule (!requiretty, !use_pty) runs the script as the deploy user; any other path is refused; SIGTERM to the group is relayed to the script");
  it.todo("a script running as another user that ignores SIGTERM: the agent cannot SIGKILL it; the run ends LOST/timed out and the target stays held (script requirement)");
  it.todo("SIGKILL of the agent process during a deploy: the next start stops the still-running script (pid + /proc start time) before receiving, and reports LOST");
  it.todo("agent run directly with node and under an existing PM2 daemon (treekill false, kill_timeout): stop and restart drain; Docker containers and PM2 applications keep running");
  it.todo("processes a script hands over are reparented outside the agent's process tree (PM2 is not a subreaper) and survive the agent");
  it.todo("a script leaving a process in its process group is reported, and the process survives the agent stop");
  it.todo("SQS: a message handed back with visibility 0 is received again by the restarted agent; retention, visibility timeout and the DLQ redrive of the E4 templates hold commands during a stop");
  it.todo("S3 PutObject with SSE-S3 into the private bucket; IAM denies the agent anything outside its prefixes");
  it.todo("idle and concurrent-deploy footprint of the agent process on the Linux host (RSS, CPU, requests per hour)");
});
