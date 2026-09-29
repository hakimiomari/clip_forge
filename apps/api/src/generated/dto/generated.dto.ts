import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import {
  GENERATED_STYLES,
  MAX_GENERATED_SECONDS,
  MIN_GENERATED_SECONDS,
} from "@clipforge/shared-types";

export class CreateGeneratedVideoDto {
  @ApiProperty({
    description: "What the video should show",
    example: "A person in a sleek VR headset inside a glowing holographic interface, neon blue and purple",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(600)
  prompt: string;

  @ApiPropertyOptional({ enum: ["vertical", "square", "landscape"], default: "vertical" })
  @IsOptional()
  @IsIn(["vertical", "square", "landscape"])
  format: string = "vertical";

  @ApiPropertyOptional({
    description: `Finished length in seconds (${MIN_GENERATED_SECONDS}–${MAX_GENERATED_SECONDS})`,
    default: 8,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_GENERATED_SECONDS)
  @Max(MAX_GENERATED_SECONDS)
  targetSeconds: number = 8;

  @ApiPropertyOptional({
    enum: GENERATED_STYLES.map((s) => s.value),
    default: "cinematic",
  })
  @IsOptional()
  @IsIn(GENERATED_STYLES.map((s) => s.value))
  style: string = "cinematic";
}
