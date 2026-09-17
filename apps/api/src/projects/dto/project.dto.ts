import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  Equals,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Type } from "class-transformer";

export class CreateProjectDto {
  @ApiPropertyOptional({ example: "Podcast episode 42" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
}

export class UpdateProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
}

export enum ImportSourceType {
  UPLOAD = "UPLOAD",
  YOUTUBE = "YOUTUBE",
}

export enum ImportRights {
  OWNED = "OWNED",
  LICENSED = "LICENSED",
  CREATIVE_COMMONS = "CREATIVE_COMMONS",
  PUBLIC_DOMAIN = "PUBLIC_DOMAIN",
  PERMISSION_GRANTED = "PERMISSION_GRANTED",
}

export class ImportSourceDto {
  @ApiProperty({ enum: ImportSourceType })
  @IsEnum(ImportSourceType)
  sourceType: ImportSourceType;

  @ApiPropertyOptional({
    description: "Storage key returned by POST /uploads/presign (UPLOAD only)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  storageKey?: string;

  @ApiPropertyOptional({
    description: "Source video URL (YOUTUBE only)",
    example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  url?: string;

  @ApiProperty({
    description:
      "User confirms they own, have permission to use, or are legally authorized to process this content",
  })
  @IsBoolean()
  @Equals(true, {
    message:
      "You must confirm you have rights or authorization to process this content",
  })
  rightsConfirmed: boolean;

  @ApiProperty({ enum: ImportRights })
  @IsEnum(ImportRights)
  rights: ImportRights;

  @ApiPropertyOptional({ description: "Attribution / license note" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rightsNote?: string;
}

export class ListProjectsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 12, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 12;
}
