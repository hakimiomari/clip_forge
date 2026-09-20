"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UploadCloud, Youtube, FileVideo, X } from "lucide-react";
import type { PresignedUpload } from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, FieldError } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/progress";

type SourceTab = "upload" | "youtube";

const RIGHTS_OPTIONS = [
  { value: "OWNED", label: "I created this content and own it" },
  { value: "LICENSED", label: "I have a license to use it" },
  { value: "PERMISSION_GRANTED", label: "The owner gave me permission" },
  { value: "CREATIVE_COMMONS", label: "It is Creative Commons licensed" },
  { value: "PUBLIC_DOMAIN", label: "It is in the public domain" },
] as const;

const ACCEPTED_TYPES: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/webm": ".webm",
};

export default function NewProjectPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<SourceTab>("upload");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [rights, setRights] = useState<string>("OWNED");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectFile = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!ACCEPTED_TYPES[f.type]) {
      setError("Unsupported file type — use MP4, MOV, MKV or WebM");
      return;
    }
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
  };

  /** Uploads the file straight to object storage via a presigned URL. */
  const uploadToStorage = (upload: PresignedUpload, f: File): Promise<void> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", upload.uploadUrl);
      xhr.setRequestHeader("Content-Type", f.type);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadPct((e.loaded / e.total) * 100);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`Upload failed (${xhr.status})`));
      xhr.onerror = () => reject(new Error("Upload failed — check that storage is running"));
      xhr.send(f);
    });

  const handleSubmit = async () => {
    setError(null);
    if (!rightsConfirmed) {
      setError("Please confirm you have rights or authorization to process this content.");
      return;
    }
    if (tab === "upload" && !file) {
      setError("Choose a video file to upload.");
      return;
    }
    if (tab === "youtube" && !youtubeUrl.trim()) {
      setError("Paste a YouTube URL.");
      return;
    }

    setSubmitting(true);
    try {
      let storageKey: string | undefined;
      if (tab === "upload" && file) {
        const presigned = await api<PresignedUpload>("/uploads/presign", {
          method: "POST",
          body: {
            fileName: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          },
        });
        setUploadPct(0);
        await uploadToStorage(presigned, file);
        setUploadPct(null);
        storageKey = presigned.storageKey;
      }

      const project = await api<{ id: string }>("/projects", {
        method: "POST",
        body: { name: name.trim() || undefined },
      });

      await api(`/projects/${project.id}/import`, {
        method: "POST",
        body:
          tab === "upload"
            ? { sourceType: "UPLOAD", storageKey, rights, rightsConfirmed: true }
            : { sourceType: "YOUTUBE", url: youtubeUrl.trim(), rights, rightsConfirmed: true },
      });

      router.push(`/projects/${project.id}`);
    } catch (err) {
      setUploadPct(null);
      setError(err instanceof ApiError ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">New project</h1>
      <p className="mb-8 text-sm text-muted">
        Import a video to analyze. ClipForge processes content you own, have
        permission to use, or are legally authorized to process.
      </p>

      <Card className="space-y-6">
        <div>
          <Label htmlFor="project-name">Project name</Label>
          <Input
            id="project-name"
            placeholder="e.g. Podcast episode 42"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <Label>Video source</Label>
          <div className="mb-4 grid grid-cols-2 gap-2">
            {(
              [
                { key: "upload", label: "Upload file", icon: UploadCloud },
                { key: "youtube", label: "YouTube URL", icon: Youtube },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium transition-colors",
                  tab === key
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border text-muted hover:border-border-strong",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          {tab === "upload" ? (
            file ? (
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface-raised px-4 py-3">
                <div className="flex items-center gap-3 overflow-hidden">
                  <FileVideo className="h-5 w-5 shrink-0 text-primary" />
                  <div className="overflow-hidden">
                    <p className="truncate text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted">{formatBytes(file.size)}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  className="text-muted hover:text-foreground"
                  aria-label="Remove file"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  selectFile(e.dataTransfer.files?.[0]);
                }}
                className="flex w-full flex-col items-center rounded-lg border border-dashed border-border-strong px-4 py-10 text-center transition-colors hover:border-primary/60 hover:bg-primary/5"
              >
                <UploadCloud className="mb-2 h-7 w-7 text-muted" />
                <p className="text-sm font-medium">
                  Drop a video here or click to browse
                </p>
                <p className="mt-1 text-xs text-muted">
                  MP4, MOV, MKV or WebM — up to 4 GB
                </p>
              </button>
            )
          ) : (
            <div>
              <Input
                placeholder="https://www.youtube.com/watch?v=…"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
              />
              <p className="mt-2 text-xs text-muted">
                ClipForge analyses the video by streaming it and fetches only
                the seconds each clip needs — the full video is never
                downloaded. Only import videos you own or are authorized to
                use — you confirm this below.
              </p>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={Object.values(ACCEPTED_TYPES).join(",")}
            className="hidden"
            onChange={(e) => selectFile(e.target.files?.[0])}
          />
        </div>

        <div>
          <Label htmlFor="rights">Content rights</Label>
          <select
            id="rights"
            value={rights}
            onChange={(e) => setRights(e.target.value)}
            className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {RIGHTS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm text-muted-strong">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(e) => setRightsConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#6d5cff]"
            />
            <span>
              I confirm that I own, have permission to use, or am legally
              authorized to process and publish this content.
            </span>
          </label>
        </div>

        {uploadPct !== null && (
          <ProgressBar value={uploadPct} label="Uploading video" />
        )}
        <FieldError message={error ?? undefined} />

        <Button
          className="w-full"
          size="lg"
          loading={submitting}
          onClick={handleSubmit}
        >
          {submitting && uploadPct !== null
            ? "Uploading…"
            : "Create project & import"}
        </Button>
      </Card>
    </div>
  );
}
