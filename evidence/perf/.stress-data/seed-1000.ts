import { openStore } from "/home/haroldzhao/MyProj/DshProj/MailCollect/packages/core/src/index.ts";
const store = await openStore("/home/haroldzhao/MyProj/DshProj/MailCollect/evidence/perf/.stress-data/integration-heavy/mailcollect.sqlite", "stress-heavy");
const profile = store.getProfile();
if (profile === null) throw new Error("profile missing");
const base = Date.parse("2026-11-09T02:00:00.000Z");
const hours = 60 * 60 * 1000;
const tasks = Array.from({ length: 1000 }, (_, index) => {
  const start = new Date(base + index * 2 * hours);
  const end = new Date(start.getTime() + 3 * hours);
  return {
    id: "heavy-" + index,
    userId: profile.id,
    title: "压测任务 " + index,
    detail: null,
    owner: "me",
    ownerName: profile.displayName,
    kind: "action",
    status: "confirmed",
    origin: "personal",
    confidence: 0.9,
    evidenceQuote: "压测",
    sourceEmailId: "e1",
    threadId: null,
    time: { phrase: null, dueAt: null, windowStart: start.toISOString(), windowEnd: end.toISOString(), timezone: "Asia/Shanghai", confidence: 0.9 },
    createdAt: new Date(base).toISOString(),
    updatedAt: new Date(base).toISOString(),
  };
});
store.insertTasks(tasks);
store.close();
console.log("seeded 1000 tasks");
