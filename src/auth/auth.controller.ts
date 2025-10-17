import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import type { Request as ExpressRequest } from 'express';
import type { User } from '../../generated/prisma';
import {
  LoginDto,
  RegisterDto,
  RefreshDto,
  AuthWithUserResponseDto,
  AuthTokensDto,
} from './dto/auth.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @ApiOkResponse({ type: AuthWithUserResponseDto })
  @ApiBody({ type: RegisterDto })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @UseGuards(LocalAuthGuard)
  @Post('login')
  @ApiOkResponse({ type: AuthWithUserResponseDto })
  @ApiBody({ type: LoginDto })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @Post('profile')
  getProfile(
    @Request()
    req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
  ): Omit<User, 'passwordHash'> {
    return req.user;
  }

  @Post('refresh')
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiBody({ type: RefreshDto })
  refresh(@Body() refreshDto: RefreshDto) {
    return this.authService.refresh(refreshDto);
  }
}
