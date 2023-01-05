import { spawn } from "child_process";
import { promises as fs } from "fs";
import process from "process";

import { readLangConfig } from "../lib/yaml.js";
import * as k8s from "./k8s.js";
import { deptyify, getUUID } from "./util.js";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const sandboxScript = await fs.readFile("backend/sandbox.bash", "utf-8");
  const lang = process.env.L;
  if (!lang) {
    die("environment variable unset: $L");
  }
  const langConfig = await readLangConfig(lang);
  console.log(`Checking for existing sessions`);
  const existingSessions = await k8s.listUserSessions();
  if (existingSessions.length > 0) {
    console.log(`Killing ${existingSessions.length} existing session(s)`);
    await k8s.deleteUserSessions(existingSessions);
  }
  const sessionID = getUUID();
  console.log(`Starting session with UUID ${sessionID}`);
  const watcher = k8s.watchPods();
  const podName = await k8s.createUserSession({
    watcher,
    sessionID,
    langConfig,
    revisions: {
      agent: "20230104-131916-extensive-aquamarine-crocodile",
      ptyify: "20221228-023645-clean-white-gorilla",
      langImage: "20221227-195753-forward-harlequin-wolverine",
    },
  });
  const proxyInfo = {
    httpProtocol: "https",
    wsProtocol: "wss",
    host: "k8s.riju.codes",
    port: 1869,
    username: "admin",
    password: process.env.RIJU_PROXY_PASSWORD,
  };
  console.log(`Waiting for session to become ready`);
  const session = await k8s.initUserSession({
    watcher,
    podName,
    proxyInfo,
  });
  console.log(`Initializing sandbox`);
  let handlePtyInput;
  const pty = await deptyify({
    handlePtyInput: (data) => handlePtyInput(data),
    handlePtyExit: (_status) => {},
  });
  await new Promise((resolve) => {
    const exec = session.exec(["bash"], {
      pty: true,
      on: {
        stdout: (data) => pty.handlePtyOutput(data),
        stderr: (data) => process.stderr.write(data),
        exit: (status) => process.exit(status),
        error: (err) => process.stderr.write(`riju: error: ${err}\n`),
        close: () => resolve(),
      },
    });
    handlePtyInput = (data) => exec.stdin.write(data);
  });
}

main().catch(die);
