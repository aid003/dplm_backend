import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { JwtSignOptions } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcrypt';
import { LoginDto, RegisterDto, RefreshDto } from './dto/auth.dto';
import type { User } from '../../generated/prisma';

type PublicUser = Omit<User, 'passwordHash'>;

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async validateUser(
    email: string,
    password: string,
  ): Promise<PublicUser | null> {
    const user = await this.usersService.findByEmail(email);
    if (user && (await bcrypt.compare(password, user.passwordHash))) {
      const publicUser: PublicUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };
      return publicUser;
    }
    return null;
  }

  private resolveExpires(
    value: string | undefined,
    fallback: JwtSignOptions['expiresIn'],
  ): JwtSignOptions['expiresIn'] {
    if (value == null || value === '') return fallback;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric as JwtSignOptions['expiresIn'];
    }
    if (/^\d+(ms|s|m|h|d|w|y)$/i.test(value)) {
      return value as unknown as JwtSignOptions['expiresIn'];
    }
    return fallback;
  }

  private generateTokens(user: PublicUser): {
    access_token: string;
    refresh_token: string;
  } {
    const payload = { email: user.email, sub: user.id };
    const accessSecret = this.configService.get<string>('JWT_ACCESS_SECRET');
    const refreshSecret = this.configService.get<string>('JWT_REFRESH_SECRET');
    if (!accessSecret || !refreshSecret) {
      throw new Error('JWT_ACCESS_SECRET or JWT_REFRESH_SECRET is not set');
    }
    const accessExpiresIn = this.resolveExpires(
      this.configService.get<string>('JWT_ACCESS_EXPIRES_IN'),
      '15m',
    );
    const refreshExpiresIn = this.resolveExpires(
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN'),
      '7d',
    );

    const access_token = this.jwtService.sign(payload, {
      secret: accessSecret,
      expiresIn: accessExpiresIn,
    });
    const refresh_token = this.jwtService.sign(payload, {
      secret: refreshSecret,
      expiresIn: refreshExpiresIn,
    });
    return { access_token, refresh_token };
  }

  async login(loginDto: LoginDto) {
    const user = await this.validateUser(loginDto.email, loginDto.password);
    if (!user) {
      throw new UnauthorizedException('Неверные учетные данные');
    }

    const tokens = this.generateTokens(user);
    return { ...tokens, user };
  }

  async register(registerDto: RegisterDto) {
    const existingUser = await this.usersService.findByEmail(registerDto.email);
    if (existingUser) {
      throw new UnauthorizedException(
        'Пользователь с таким email уже существует',
      );
    }

    const passwordHash = await bcrypt.hash(registerDto.password, 10);
    const { username, email } = registerDto;
    const user = await this.usersService.create({
      username,
      email,
      passwordHash,
    });

    const publicUser: PublicUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
    const tokens = this.generateTokens(publicUser);
    return { ...tokens, user: publicUser };
  }

  async refresh(
    refreshDto: RefreshDto,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const refreshSecret = this.configService.get<string>('JWT_REFRESH_SECRET');
    if (!refreshSecret) {
      throw new Error('JWT_REFRESH_SECRET is not set');
    }
    try {
      const payload = this.jwtService.verify<{ sub: string; email: string }>(
        refreshDto.refreshToken,
        { secret: refreshSecret },
      );
      const user = await this.usersService.findById(payload.sub);
      if (!user) {
        throw new UnauthorizedException('Пользователь не найден');
      }
      const publicUser: PublicUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };
      return this.generateTokens(publicUser);
    } catch {
      throw new UnauthorizedException('Недействительный refresh токен');
    }
  }
}
