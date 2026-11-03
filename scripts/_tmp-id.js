const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const n = await p.note.findFirst({ orderBy: { updatedAt: 'desc' } });
  for (const line of String(n.content).split('\n')) {
    if (/\*(dogma|lógos|mythos)/.test(line)) console.log(JSON.stringify(line.slice(0, 200)));
  }
  await p.$disconnect();
})();
