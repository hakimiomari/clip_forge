import { ApiProperty } from "@nestjs/swagger";
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class RegisterDto {
  @ApiProperty({ example: "Ada Lovelace", required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({ example: "ada@example.com" })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8, example: "correct-horse-battery" })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

export class LoginDto {
  @ApiProperty({ example: "ada@example.com" })
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  password: string;
}
