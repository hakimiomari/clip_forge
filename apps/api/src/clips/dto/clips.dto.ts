import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { MAX_CLIP_PARTS } from "@clipforge/shared-types";

export enum VoiceEffectDto {
  none = "none",
  telephone = "telephone",
  echo = "echo",
  robot = "robot",
}

/** Voice/audio controls; every field optional — omitted = unchanged. */
export class AudioSettingsDto {
  @ApiPropertyOptional({ description: "Gain 0–3 (1 = normal, 2 = double)" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(3)
  volume?: number;

  @ApiPropertyOptional({ description: "Pitch in semitones, −12 (deep) … +12 (high)" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-12)
  @Max(12)
  pitchSemitones?: number;

  @ApiPropertyOptional({ description: "Bass gain dB, −10…10" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-10)
  @Max(10)
  bassGain?: number;

  @ApiPropertyOptional({ description: "Treble gain dB, −10…10" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-10)
  @Max(10)
  trebleGain?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  noiseReduction?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  voiceEnhance?: boolean;

  @ApiPropertyOptional({ enum: VoiceEffectDto })
  @IsOptional()
  @IsEnum(VoiceEffectDto)
  voiceEffect?: VoiceEffectDto;

  @ApiPropertyOptional({ description: "Loudness normalization" })
  @IsOptional()
  @IsBoolean()
  normalize?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  fadeIn?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  fadeOut?: boolean;
}
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

export enum CtaTimingDto {
  start = "start",
  middle = "middle",
  end = "end",
  always = "always",
  custom = "custom",
}

/** Like/Follow banner settings; omitted fields keep their current value. */
export class CtaSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: "LIKE" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  likeText?: string;

  @ApiPropertyOptional({ example: "FOLLOW" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  followText?: string;

  @ApiPropertyOptional({ enum: CtaTimingDto })
  @IsOptional()
  @IsEnum(CtaTimingDto)
  timing?: CtaTimingDto;

  @ApiPropertyOptional({ description: "Custom window start (s), timing=custom" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(600)
  customStart?: number;

  @ApiPropertyOptional({ description: "Custom window end (s), timing=custom" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(600)
  customEnd?: number;

  @ApiPropertyOptional({ enum: ["top", "bottom"] })
  @IsOptional()
  @IsEnum({ top: "top", bottom: "bottom" })
  position?: "top" | "bottom";
}

/** AI subject cut-out settings (edit-time feature). */
export class BackgroundRemovalDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: ["blur", "color"] })
  @IsOptional()
  @IsEnum({ blur: "blur", color: "color" })
  replace?: "blur" | "color";

  @ApiPropertyOptional({ description: "6-digit hex without #", example: "0b0d12" })
  @IsOptional()
  @IsString()
  @MaxLength(6)
  color?: string;
}

/** AI cartoon / anime stylization of the footage. */
export class CartoonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: ["hayao", "shinkai"], default: "hayao" })
  @IsOptional()
  @IsIn(["hayao", "shinkai"])
  style?: "hayao" | "shinkai";

  @ApiPropertyOptional({
    description: "Frames per second to stylize at (8–30); 12 reads as hand-drawn",
    default: 12,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(8)
  @Max(30)
  fps?: number;

  @ApiPropertyOptional({
    enum: ["standard", "high"],
    default: "high",
    description: "high = stylize at export resolution (sharper, slower)",
  })
  @IsOptional()
  @IsIn(["standard", "high"])
  quality?: "standard" | "high";
}

export class CreateClipDto {
  @ApiPropertyOptional({ example: "The biggest mistake" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: "Like/Follow banner", default: true })
  @IsOptional()
  @IsBoolean()
  ctaEnabled: boolean = true;

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

  @ApiPropertyOptional({ type: CartoonDto, description: "Cartoon-style the footage" })
  @IsOptional()
  @ValidateNested()
  @Type(() => CartoonDto)
  cartoon?: CartoonDto;
}

/** One part of a stitched clip. */
export class ClipPartDto {
  @ApiProperty({ description: "Part start in the source (seconds)" })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  sourceStart: number;

  @ApiProperty({ description: "Part end in the source (seconds)" })
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  sourceEnd: number;
}

/**
 * Creating a clip from the timeline: either one range, or `segments`
 * with several parts that play back to back in the order given.
 */
export class CreateClipFromRangeDto extends CreateClipDto {
  @ApiPropertyOptional({ description: "Clip start in the source (seconds)" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  sourceStart?: number;

  @ApiPropertyOptional({ description: "Clip end in the source (seconds)" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  sourceEnd?: number;

  @ApiPropertyOptional({
    type: [ClipPartDto],
    description: `Parts stitched in order (max ${MAX_CLIP_PARTS}); overrides sourceStart/sourceEnd`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CLIP_PARTS)
  @ValidateNested({ each: true })
  @Type(() => ClipPartDto)
  segments?: ClipPartDto[];
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

  @ApiPropertyOptional({ type: AudioSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AudioSettingsDto)
  audio?: AudioSettingsDto;

  @ApiPropertyOptional({ type: CtaSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CtaSettingsDto)
  cta?: CtaSettingsDto;

  @ApiPropertyOptional({ type: BackgroundRemovalDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BackgroundRemovalDto)
  backgroundRemoval?: BackgroundRemovalDto;

  @ApiPropertyOptional({ type: CartoonDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CartoonDto)
  cartoon?: CartoonDto;
}
