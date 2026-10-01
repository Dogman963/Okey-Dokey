/**
 * 测一测移动端每次 reveal/copy 到底慢在哪。
 *
 * 怀疑：store.touch() 会整库重新加密落盘（scrypt），而移动端的 scrypt 是纯 JS 实现。
 * 如果单次 scrypt 就是秒级，那"点 Reveal 要等几秒"就完全对得上。
 * 用同一份 scrypt-js（浏览器里跑的就是它）在 Node 上量，得到的量级可直接外推。
 */
import scryptJs from 'scrypt-js';
const scrypt = scryptJs.scrypt || scryptJs;

const pw = new TextEncoder().encode('a1'.repeat(32));
const salt = new Uint8Array(16);

async function timeIt(label, N, runs = 3) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await scrypt(pw, salt, N, 8, 1, 32);
    times.push(performance.now() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`  ${label.padEnd(34)} N=${String(N).padEnd(6)} 平均 ${avg.toFixed(0)} ms  (${times.map(t => t.toFixed(0)).join(' / ')} ms)`);
  return avg;
}

console.log('\n纯 JS scrypt 单次耗时（Node 上量，浏览器同实现）：');
const a = await timeIt('本机库 device.key 派生 N=16384', 16384);
const b = await timeIt('导出包 passphrase 派生 N=32768', 32768);

console.log('\n推断（移动端 CPU 通常比本机慢 2~4 倍）：');
console.log(`  touch() → _write() → deriveKey 至少 ${a.toFixed(0)} ms/次`);
console.log(`  手机端估算 ${(a * 2).toFixed(0)} ~ ${(a * 4).toFixed(0)} ms`);
console.log('\n结论：若 reveal/copy 每次都要等 touch() 落盘，等待时间就是这个量级。');
