import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateResearchVideoDto {
  @ApiProperty({
    description: "Topic to research and turn into a video",
    example: "The history of the Cricket World Cup",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  prompt: string;

  @ApiPropertyOptional({ enum: ["vertical", "square", "landscape"], default: "vertical" })
  @IsOptional()
  @IsIn(["vertical", "square", "landscape"])
  format: string = "vertical";
}
