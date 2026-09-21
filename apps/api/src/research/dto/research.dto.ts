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

  @ApiPropertyOptional({
    enum: ["none", "hayao", "shinkai", "ai"],
    default: "none",
    description:
      "Look for every scene's picture. hayao/shinkai redraw the Commons " +
      "photograph locally; ai draws the scene from its sentence instead " +
      "of using a photograph at all. All three add build time.",
  })
  @IsOptional()
  @IsIn(["none", "hayao", "shinkai", "ai"])
  cartoonStyle: string = "none";
}
