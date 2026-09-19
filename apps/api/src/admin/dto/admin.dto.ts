import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

export enum AdminRole {
  USER = "USER",
  ADMIN = "ADMIN",
}

export enum AdminPlan {
  FREE = "FREE",
  STARTER = "STARTER",
  PRO = "PRO",
  BUSINESS = "BUSINESS",
}

export class AdminListUsersQueryDto {
  @ApiPropertyOptional({ description: "Search by email or name" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  query?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

export class AdminUpdateUserDto {
  @ApiPropertyOptional({ enum: AdminRole })
  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;

  @ApiPropertyOptional({ enum: AdminPlan })
  @IsOptional()
  @IsEnum(AdminPlan)
  plan?: AdminPlan;

  @ApiPropertyOptional({ description: "true suspends, false reinstates" })
  @IsOptional()
  @IsBoolean()
  suspended?: boolean;
}

export class AdminAdjustCreditsDto {
  @ApiProperty({
    description: "Positive grants credits, negative removes them",
    example: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  amount: number;
}
