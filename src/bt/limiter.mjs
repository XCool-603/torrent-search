/**
 * 下载限速（令牌桶）。
 *
 * 为什么需要：BT 会尽可能吃满带宽，长期挂机时会拖垮同网络的所有应用。
 * 令牌桶按固定速率补充令牌，请求多少字节的分片就消耗多少令牌，
 * 令牌不足时排队等待——这样"平均速率"被精确限制，同时允许短暂的突发。
 *
 * 用法（在 Peer.requestBlock 里，发请求前获取令牌）：
 *   await limiter.acquire(blockLength);
 *
 * 关键设计：
 *   - 桶容量 = 速率（1 秒的量），单次请求的字节数会被钳制到 ≤ 速率，
 *     因此最多等约 1 个补充周期，不会出现"设了 1 B/s 就等一万年"的脚枪；
 *   - FIFO：先请求的先拿令牌，避免饿死；
 *   - interval 用 unref：进程若只剩限速器在跑，不应阻止退出
 *     （真实下载时有活跃的 TCP socket 撑着事件循环，不受影响）。
 */

/**
 * 解析人类可写的限速值："2M" / "500K" / "1.5M" / 纯数字（字节/秒）。
 *
 * @param {string|number|null|undefined} value
 * @returns {number|null} 字节/秒，无法解析返回 null
 */
export function parseSpeedLimit(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }

  const text = String(value).trim().toLowerCase();
  if (text === '' || text === '0' || text === 'off' || text === 'none') return null;

  const match = text.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = (match[2] ?? '').replace(/i?b$/, '');
  const factors = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  const factor = factors[unit];
  if (factor === undefined) return null;

  const bytesPerSecond = Math.floor(amount * factor);
  return bytesPerSecond > 0 ? bytesPerSecond : null;
}

export class SpeedLimiter {
  /**
   * @param {{bytesPerSecond: number, logger?: (msg: string) => void}} options
   */
  constructor(options) {
    const rate = Math.floor(Number(options.bytesPerSecond));
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`限速值非法：${options.bytesPerSecond}`);

    this.rate = rate;
    this.logger = options.logger ?? (() => {});
    // 初始令牌为 0：如果初始就装满（= rate），那么"头一秒"等于不限速，
    // 短下载（总量小于一个桶）会完全绕过限速——实测踩过的坑。
    // 代价是第一秒的突发被压平，对 BT 这种长跑场景是正确取舍。
    this.tokens = 0;
    this.last = Date.now();
    /** @type {Array<{need: number, resolve: Function, timer: any}>} */
    this.waiters = [];

    this.timer = setInterval(() => this.refill(), 100);
    // 空闲时不阻塞进程退出；一旦有人在等令牌，就 ref 住（见 acquire/dispatch）。
    // 早期版本无条件 unref，导致"等待令牌"成为唯一待处理工作时进程直接退出——
    // 在 Node 20 上被 CI 抓到（本地 Node 26 掩盖了这个问题）。
    this.timer.unref?.();
  }

  /** 按经过的时间补充令牌（上限 = 桶容量）。 */
  refill() {
    const now = Date.now();
    const elapsedMs = now - this.last;
    if (elapsedMs <= 0) return;

    this.last = now;
    this.tokens = Math.min(this.rate, this.tokens + (elapsedMs / 1000) * this.rate);
    this.dispatch();
  }

  /**
   * 把现有令牌按 FIFO 分给等待者。
   *
   * 关键：waiter 的 need 可能大于桶容量（rate）——例如"一次拿 200 KiB 但限速 100 KiB/s"。
   * 此时令牌永远攒不到 need，必须**部分分配**：有多少给多少，扣减 need，
   * need 归零才放行（否则这个 waiter 会永远卡住，实测踩过的坑）。
   */
  dispatch() {
    while (this.waiters.length > 0 && this.tokens > 0) {
      const waiter = this.waiters[0];
      const grant = Math.min(this.tokens, waiter.need);
      this.tokens -= grant;
      waiter.need -= grant;

      if (waiter.need > 0) break; // 令牌用完了，等下一轮 refill

      this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve();
    }

    // 没有等待者就放开事件循环：否则一个已不再使用的限速器会一直拖住进程
    if (this.waiters.length === 0) this.timer?.unref?.();
  }

  /**
   * 获取 bytes 个令牌，不足时排队等待补充。
   *
   * 对超过桶容量的大额请求：先扣掉现有令牌，剩余部分进入 FIFO 队列
   * 等补充（每 100ms 补 rate/10），保证「平均速率 ≤ rate」这个承诺真正成立。
   * （早期版本把大额请求钳到桶容量，导致限速完全失效——被测试抓出来的真 bug。）
   *
   * @param {number} bytes
   * @returns {Promise<void>}
   */
  acquire(bytes) {
    const want = Math.floor(Number(bytes));
    if (!Number.isFinite(want) || want <= 0) return Promise.resolve();

    // 现有令牌够：直接扣（含部分扣减）
    if (this.tokens >= want) {
      this.tokens -= want;
      return Promise.resolve();
    }

    const remaining = want - this.tokens;
    this.tokens = 0;

    // 有人开始等令牌 → 把补充定时器 ref 住，保证进程不会在等待期间退出
    this.timer?.ref?.();

    return new Promise((resolve) => {
      const waiter = { need: remaining, resolve, timer: null };
      // 兜底：系统挂起导致 interval 停摆时不至于永远卡住
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          resolve();
        }
      }, 60_000);
      waiter.timer.unref?.();

      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  /** 停止补充（下载结束/取消时调用，避免 interval 泄漏）。 */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.waiters = [];
  }
}
