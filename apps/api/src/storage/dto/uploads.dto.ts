import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export const ALLOWED_UPLOAD_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
] as const;

export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;

export class PresignUploadDto {
  @ApiProperty({ example: "episode-42.mp4" })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName: string;

  @ApiProperty({ enum: ALLOWED_UPLOAD_TYPES })
  @IsIn(ALLOWED_UPLOAD_TYPES, {
    message: "Unsupported file type — use MP4, MOV, MKV or WebM",
  })
  contentType: string;

  @ApiProperty({ example: 104857600 })
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES, { message: "Files must be 4 GB or smaller" })
  sizeBytes: number;
}
