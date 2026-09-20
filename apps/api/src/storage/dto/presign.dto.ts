import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsInt, IsString, Max, MaxLength, Min } from "class-validator";

export const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
] as const;

/** 4 GB upload ceiling for now — enforced again by plan limits later. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

export class PresignUploadDto {
  @ApiProperty({ example: "interview.mp4" })
  @IsString()
  @MaxLength(200)
  fileName: string;

  @ApiProperty({ enum: ALLOWED_VIDEO_TYPES })
  @IsIn(ALLOWED_VIDEO_TYPES as unknown as string[])
  contentType: string;

  @ApiProperty({ description: "File size in bytes" })
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES)
  sizeBytes: number;
}
