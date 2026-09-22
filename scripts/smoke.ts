// 用法: 先 npm run dev 启动服务，再 npm run smoke
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3456';
const key = process.env.SMOKE_API_KEY;
if (!key) {
  console.error('请先设置 SMOKE_API_KEY（config.yaml accessKeys 里的一个 Key）');
  process.exit(1);
}

const res = await fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    stream: false,
    messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }],
  }),
});

console.log('HTTP', res.status);
const body = await res.text();
console.log(body.slice(0, 500));
if (!res.ok) process.exit(1);
console.log('\n冒烟通过 ✅');
