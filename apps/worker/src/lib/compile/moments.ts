import { mkdir } from "fs/promises";
import path from "path";
import {
  MOMENT_SECONDS,
  type CompilationMoment,
} from "@clipforge/shared-types";
import { analyzeMedia } from "../analysis";
import { downloadAnalysisMedia } from "../youtube";
import { selectHighlights } from "../heuristics";
import type { Candidate } from "./search";

/**
 * Finds the strongest moments inside one candidate video.
 *
 * Only the audio is fetched: loudness and silence already locate the
 * crowd noise and commentary spikes that mark the interesting part of
 * sports footage, and an audio track downloads in seconds where the
 * video would take minutes.
 */
export async function findMoments(options: {
  candidate: Candidate;
  workDir: string;
  perVideo: number;
}): Promise<CompilationMoment[]> {
  const { candidate, workDir, perVideo } = options;

  // Each candidate needs its own folder. The analysis download always
  // writes the same filename, and yt-dlp skips a file that already
  // exists — so in a shared folder every video after the first was
  // silently scored using the first video's audio, and the compilation
  // cut the same timestamp out of all of them.
  const candidateDir = path.join(workDir, `candidate-${candidate.videoId}`);
  await mkdir(candidateDir, { recursive: true });

  const media = await downloadAnalysisMedia(candidate.videoId, candidateDir, {
    includeVideo: false,
  });
  const analysis = await analyzeMedia({
    audio: media.audioPath,
    video: null,
    durationSeconds: candidate.durationSeconds,
  });

  const picks = selectHighlights({
    duration: candidate.durationSeconds,
    targetLength: MOMENT_SECONDS,
    count: perVideo,
    analysis,
    // A moment only has to be long enough for the play itself; the
    // default 15s floor is for standalone clips and would reject every
    // 12s window here
    minWindowSeconds: MOMENT_SECONDS - 2,
  });
  if (picks.length === 0) {
    // Surface it rather than returning nothing silently — an empty list
    // looked like "unavailable" in the logs and hid this exact bug
    console.warn(`No moments scored in ${candidate.videoId} (${candidate.durationSeconds}s)`);
  }

  return picks.map((pick) => ({
    videoId: candidate.videoId,
    videoTitle: candidate.title,
    channel: candidate.channel,
    start: Math.max(0, Math.round(pick.startTime * 10) / 10),
    end: Math.min(
      candidate.durationSeconds,
      Math.round(pick.endTime * 10) / 10,
    ),
    score: pick.score,
    watchUrl: candidate.watchUrl,
  }));
}
