import { Queue } from "bullmq";
import IORedis from "ioredis";
import { QUEUES, type RenderVideoJob } from "@clipforge/shared-types";
import { env } from "../env";

/**
 * Producer side of the render queue, used only by automatic mode: the
 * highlight job creates the shorts itself and queues their renders, so
 * the run finishes even if the browser is closed. Everything else is
 * still enqueued by the API.
 */

let queue: Queue | null = null;
let connection: IORedis | null = null;

function renderQueue(): Queue {
  if (!queue) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUES.RENDER_VIDEO, { connection });
  }
  return queue;
}

export async function enqueueRender(payload: RenderVideoJob): Promise<void> {
  // Single attempt: the processor owns its own failure handling (status
  // + refund), exactly as the API's producer configures it.
  await renderQueue().add("render", payload, { attempts: 1 });
}

export async function closeRenderQueue(): Promise<void> {
  await queue?.close();
  connection?.disconnect();
  queue = null;
  connection = null;
}
