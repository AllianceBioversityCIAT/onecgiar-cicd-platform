// architecture-change-04 §23 — run the agent under an EXISTING PM2 daemon that is already supervised (it survives
// reboots). Example only; copy to /opt/cicd-agent/config/ and adjust. Start: pm2 start <this file>; then pm2 save.
// The agent behaves the same with or without PM2; these options only make PM2 stop it the safe way.
module.exports = {
  apps: [
    {
      name: "cicd-agent",
      script: "/opt/cicd-agent/dist/src/agent/main.js",
      // Node.js 22 for the agent only, if the server's default node is another version (applications keep theirs).
      interpreter: "/opt/cicd-agent/node/bin/node",
      cwd: "/opt/cicd-agent",
      env: { CICD_AGENT_HOME: "/opt/cicd-agent", NODE_ENV: "production" },
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      // Only the agent receives the stop signal: it stops receiving, lets running deploys finish and stops what is
      // left itself. With treekill PM2 would signal the running deploy scripts directly.
      treekill: false,
      // ms; must exceed shutdownGraceSeconds + the longest killGraceSeconds + 60 s (here 1830 + 30 + 60 s).
      kill_timeout: 1_920_000,
      // Windows only (no POSIX signals): PM2 sends the IPC message "shutdown", which the agent handles the same way.
      // shutdown_with_message: true,
      out_file: "/opt/cicd-agent/logs/agent.out.log",
      error_file: "/opt/cicd-agent/logs/agent.err.log",
      merge_logs: true,
      watch: false,
      // Only when the PM2 daemon runs as root: run the agent as its own unprivileged user.
      // uid: "cicd-agent",
      // gid: "cicd-agent",
      // Deliberately absent: max_memory_restart (it would restart the agent in the middle of deploys).
    },
  ],
};
