import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Type } from "class-transformer";
import {
  GenerateCaptionStyle,
  GenerateFormat,
} from "../../highlights/dto/highlights.dto";

export enum BackgroundMode {
  /** Fit the video, blurred bars fill the rest (default) */
  blur = "blur",
  /** Scale to cover and center-crop — fills the whole frame, no bars */
  fill = "fill",
  /** Fit the video on plain black bars */
  black = "black",
}

export class CreateClipDto {
  @ApiPropertyOptional({ example: "The biggest mistake" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: BackgroundMode, default: BackgroundMode.blur })
  @IsOptional()
  @IsEnum(BackgroundMode)
  backgroundMode: BackgroundMode = BackgroundMode.blur;

  @ApiProperty({ enum: GenerateFormat, default: GenerateFormat.vertical })
  @IsEnum(GenerateFormat)
  format: GenerateFormat = GenerateFormat.vertical;

  @ApiProperty({ default: true })
  @IsBoolean()
  captionsEnabled: boolean = true;

  @ApiPropertyOptional({ enum: GenerateCaptionStyle, default: GenerateCaptionStyle.bold_dynamic })
  @IsOptional()
  @IsEnum(GenerateCaptionStyle)
  captionStyle: GenerateCaptionStyle = GenerateCaptionStyle.bold_dynamic;

  @ApiProperty({ default: true, description: "Slow push-in zoom effect" })
  @IsBoolean()
  zoomEnabled: boolean = true;

  @ApiPropertyOptional({ description: "Shift the clip start by ± seconds", default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-30)
  @Max(30)
  trimStartDelta?: number;

  @ApiPropertyOptional({ description: "Shift the clip end by ± seconds", default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-30)
  @Max(30)
  trimEndDelta?: number;
}

export class UpdateClipDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: BackgroundMode })
  @IsOptional()
  @IsEnum(BackgroundMode)
  backgroundMode?: BackgroundMode;

  @ApiPropertyOptional({ enum: GenerateFormat })
  @IsOptional()
  @IsEnum(GenerateFormat)
  format?: GenerateFormat;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  captionsEnabled?: boolean;

  @ApiPropertyOptional({ enum: GenerateCaptionStyle })
  @IsOptional()
  @IsEnum(GenerateCaptionStyle)
  captionStyle?: GenerateCaptionStyle;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  zoomEnabled?: boolean;

  @ApiPropertyOptional({ description: "Absolute source start (seconds)" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  sourceStart?: number;

  @ApiPropertyOptional({ description: "Absolute source end (seconds)" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  sourceEnd?: number;
}
