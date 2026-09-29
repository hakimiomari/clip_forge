import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { Equals, IsBoolean, IsIn, IsOptional, IsUrl } from "class-validator";
import { PHOTO_COUNTS, PHOTO_MODES } from "@clipforge/shared-types";

export class CreatePhotoSetDto {
  @ApiProperty({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
  @IsUrl({ require_protocol: true })
  url: string;

  @ApiPropertyOptional({ enum: PHOTO_MODES.map((m) => m.value), default: "scenes" })
  @IsOptional()
  @IsIn(PHOTO_MODES.map((m) => m.value))
  mode: string = "scenes";

  @ApiPropertyOptional({ enum: [...PHOTO_COUNTS], default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsIn([...PHOTO_COUNTS])
  count: number = 24;

  @ApiProperty({ description: "Confirms the user owns the video or has permission to use it" })
  @IsBoolean()
  @Equals(true, {
    message: "You must confirm you have rights or permission to use this video",
  })
  rightsConfirmed: boolean;
}
