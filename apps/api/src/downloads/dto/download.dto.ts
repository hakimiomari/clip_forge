import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Equals, IsBoolean, IsIn, IsOptional, IsUrl } from "class-validator";
import { DOWNLOAD_QUALITIES } from "@clipforge/shared-types";

export class CreateDownloadDto {
  @ApiProperty({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
  @IsUrl({ require_protocol: true })
  url: string;

  @ApiPropertyOptional({
    enum: DOWNLOAD_QUALITIES.map((q) => q.value),
    default: "1080p",
  })
  @IsOptional()
  @IsIn(DOWNLOAD_QUALITIES.map((q) => q.value))
  quality: string = "1080p";

  @ApiProperty({
    description: "Confirms the user owns the video or has permission to download it",
  })
  @IsBoolean()
  @Equals(true, {
    message: "You must confirm you have rights or permission to download this video",
  })
  rightsConfirmed: boolean;
}
