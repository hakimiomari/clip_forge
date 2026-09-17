import IORedis from "ioredis";
import type { ProjectProgressEvent } from "@clipforge/shared-types";
import { env } from "../env";

export const PROGRESS_CHANNEL = "clipforge:progress";

const publisher = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

/** Publishes a progress event the API gateway relays to the browser. */
export async function publishProgress(
  event: ProjectProgressEvent,
): Promise<void> {
  await publisher.publish(PROGRESS_CHANNEL, JSON.stringify(event));
}

export function closeProgressPublisher(): void {
  publisher.disconnect();
}
