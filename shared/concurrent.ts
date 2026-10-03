/** Finish or cancel every independent read before the caller can yield to another job. */
export async function parallel<T extends readonly unknown[]>(...reads: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  await Promise.allSettled(reads);
  return Promise.all(reads);
}
