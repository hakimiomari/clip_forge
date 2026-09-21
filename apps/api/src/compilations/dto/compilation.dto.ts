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
  MAX_COMPILATION_SECONDS,
  MIN_COMPILATION_SECONDS,
} from "@clipforge/shared-types";

export class CreateCompilationDto {
  @ApiProperty({
    description: "What the compilation should be about",
    example: "best run outs in cricket",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  prompt: string;

  @ApiPropertyOptional({ enum: ["vertical", "square", "landscape"], default: "vertical" })
  @IsOptional()
  @IsIn(["vertical", "square", "landscape"])
  format: string = "vertical";

  @ApiPropertyOptional({
    description: `Finished length in seconds (${MIN_COMPILATION_SECONDS}–${MAX_COMPILATION_SECONDS})`,
    default: 60,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_COMPILATION_SECONDS)
  @Max(MAX_COMPILATION_SECONDS)
  targetSeconds: number = 60;
}
