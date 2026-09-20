import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

export enum GenerateFormat {
  vertical = "vertical",
  square = "square",
  landscape = "landscape",
}

export enum GenerateEditingStyle {
  clean_professional = "clean_professional",
  dynamic_viral = "dynamic_viral",
  educational = "educational",
  podcast = "podcast",
  news = "news",
  cinematic = "cinematic",
  minimal = "minimal",
}

export enum GenerateCaptionStyle {
  minimal = "minimal",
  bold_dynamic = "bold_dynamic",
  karaoke = "karaoke",
  highlighted_keywords = "highlighted_keywords",
  podcast = "podcast",
  professional = "professional",
  news = "news",
}

export class GenerateHighlightsDto {
  @ApiProperty({ description: "Target clip length in seconds (15–180)", example: 60 })
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(180)
  clipDuration: number;

  @ApiProperty({ enum: [1, 3, 5, 10], example: 5 })
  @Type(() => Number)
  @IsIn([1, 3, 5, 10])
  clipCount: number;

  @ApiPropertyOptional({ enum: GenerateFormat, default: GenerateFormat.vertical })
  @IsOptional()
  @IsEnum(GenerateFormat)
  format: GenerateFormat = GenerateFormat.vertical;

  @ApiPropertyOptional({
    enum: GenerateEditingStyle,
    default: GenerateEditingStyle.dynamic_viral,
  })
  @IsOptional()
  @IsEnum(GenerateEditingStyle)
  editingStyle: GenerateEditingStyle = GenerateEditingStyle.dynamic_viral;

  @ApiPropertyOptional({
    enum: GenerateCaptionStyle,
    default: GenerateCaptionStyle.bold_dynamic,
  })
  @IsOptional()
  @IsEnum(GenerateCaptionStyle)
  captionStyle: GenerateCaptionStyle = GenerateCaptionStyle.bold_dynamic;

  @ApiPropertyOptional({
    default: true,
    description:
      "Use the transcript (when available) to pick moments and snap cut points",
  })
  @IsOptional()
  @IsBoolean()
  useTranscript: boolean = true;

  @ApiPropertyOptional({
    default: false,
    description:
      "Automatic mode: also build and render a short for every moment found",
  })
  @IsOptional()
  @IsBoolean()
  autoCreateClips: boolean = false;

  @ApiPropertyOptional({ default: true, description: "Burn captions into automatic shorts" })
  @IsOptional()
  @IsBoolean()
  captionsEnabled: boolean = true;

  @ApiPropertyOptional({ default: true, description: "Slow push-in zoom on automatic shorts" })
  @IsOptional()
  @IsBoolean()
  zoomEnabled: boolean = true;

  @ApiPropertyOptional({ enum: ["blur", "fill", "black"], default: "blur" })
  @IsOptional()
  @IsIn(["blur", "fill", "black"])
  backgroundMode: string = "blur";

  @ApiPropertyOptional({ default: true, description: "Like & Follow banner" })
  @IsOptional()
  @IsBoolean()
  ctaEnabled: boolean = true;
}
