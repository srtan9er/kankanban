/**
 * 一个串行化的任务队列。
 *
 * 用来保证：同一个文件不会被两个写入操作同时碰到；
 * 事件日志的追加顺序和内存里的发生顺序一致。
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /** 把任务排到队尾。前一个任务失败不会卡住后面的。 */
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => undefined)
    return next
  }

  /** 等队列里现有的任务全部结束。 */
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined)
  }
}
