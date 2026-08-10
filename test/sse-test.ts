/**
 * Node smoke test for the SSE parser used by streaming chat.
 */
import { parseJsonContent, nodeStreamChat } from "../src/deepseek";
import * as http from "http";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

// parseJsonContent: tolerates markdown fences (Claude-style) and prose.
check(
  "parseJsonContent: plain JSON",
  parseJsonContent('{"a": 1}')?.a === 1,
);
check(
  "parseJsonContent: fenced JSON",
  parseJsonContent('```json\n{"a": 1}\n```')?.a === 1,
);
check(
  "parseJsonContent: prose + fenced JSON",
  parseJsonContent('Here you go:\n```\n{"a": 1}\n```\nHope that helps')?.a === 1,
);
check(
  "parseJsonContent: no JSON returns null",
  parseJsonContent("sorry, no json here") === null,
);

// Node https/http streaming: progressive deltas from a local SSE server.
async function testNodeStream(): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"i":1}\n\n');
    setTimeout(() => {
      res.write('data: {"i":2}\n\n');
      res.end();
    }, 20);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  const events: string[] = [];
  const times: number[] = [];
  try {
    await nodeStreamChat(
      `http://127.0.0.1:${addr.port}/sse`,
      {},
      { hello: "world" },
      (data) => {
        const obj = JSON.parse(data) as { i?: number };
        return obj.i !== undefined ? { delta: String(obj.i) } : null;
      },
      (e) => {
        if (e.type === "delta") {
          times.push(Date.now());
          events.push(`${e.type}:${e.content}`);
        } else {
          events.push(e.type);
        }
      },
      3000,
    );
  } finally {
    server.close();
  }
  check("node stream: both deltas emitted", events.join("|") === "delta:1|delta:2", events);
  check(
    "node stream: deltas arrived progressively, not in one burst",
    times.length === 2 && times[1] > times[0],
    times,
  );
}

async function runAll(): Promise<void> {
  await testNodeStream();
  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}
void runAll();
