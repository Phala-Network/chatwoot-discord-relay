/** Set the one Durable Object alarm for the earliest durable wake-up. */
export async function scheduleAlarm(state: DurableObjectState, next: number | undefined): Promise<void> {
  if (next === undefined) return;
  const current = await state.storage.getAlarm();
  if (current === null || current > next) await state.storage.setAlarm(Math.max(Date.now(), next));
}
