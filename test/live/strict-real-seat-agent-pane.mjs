// Run from a separate foreground WSL tab. Only filtered text reaches it.
import net from "node:net";
import { bindControlTerminal } from "./strict-real-seat-rehearsal.mjs";
import { createStrictPtyOutput, PTY_OUTPUT_MAX_CHUNK } from "../../lib/strict-pty-output.mjs";

const [path] = process.argv.slice(2);
if (process.argv.length !== 3 || !/^\/tmp\/skel-wslg-state-[a-z0-9_]{8}\/agent\.sock$/.test(path)
    || !bindControlTerminal(process.stdin, process.stdout)()) process.exit(2);
const filter = createStrictPtyOutput();
const socket = net.createConnection(path);
let answer = "";
let sent = false;
function stop() {
  process.stdin.pause();
  socket.destroy();
}
socket.on("error", () => { process.exitCode = 1; stop(); });
socket.on("close", () => { filter.end(); stop(); });
socket.on("connect", () => {
  process.stdout.write("Agent witness pane. After Claude opens, type witness and press Enter once.\n");
  process.stdin.resume();
});
socket.on("data", (bytes) => {
  for (let offset = 0; offset < bytes.length; offset += PTY_OUTPUT_MAX_CHUNK) {
    if (!process.stdout.write(filter.push(bytes.subarray(offset, offset + PTY_OUTPUT_MAX_CHUNK)))) {
      socket.pause();
      process.stdout.once("drain", () => socket.resume());
    }
  }
});
process.stdin.on("data", (bytes) => {
  if (sent || answer.length + bytes.length > 8) return stop();
  answer += bytes.toString("latin1");
  if (!"witness\n".startsWith(answer)) return stop();
  if (answer === "witness\n") {
    sent = true;
    socket.write(answer);
  }
});
process.stdin.on("end", stop);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, stop);
