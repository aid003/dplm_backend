import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { User } from '../../generated/prisma';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async findAll(): Promise<User[]> {
    try {
      return await this.databaseService.user.findMany({
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      this.logger.error('Error fetching users:', error);
      throw error;
    }
  }

  async findById(id: string): Promise<User | null> {
    try {
      return await this.databaseService.user.findUnique({
        where: { id },
      });
    } catch (error) {
      this.logger.error(`Error fetching user with id ${id}:`, error);
      throw error;
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    try {
      return await this.databaseService.user.findUnique({
        where: { email },
      });
    } catch (error) {
      this.logger.error(`Error fetching user with email ${email}:`, error);
      throw error;
    }
  }

  async create(userData: {
    username: string;
    email: string;
    passwordHash: string;
  }): Promise<User> {
    try {
      return await this.databaseService.user.create({
        data: userData,
      });
    } catch (error) {
      this.logger.error('Error creating user:', error);
      throw error;
    }
  }

  async update(
    id: string,
    userData: Partial<{
      username: string;
      email: string;
      passwordHash: string;
    }>,
  ): Promise<User> {
    try {
      return await this.databaseService.user.update({
        where: { id },
        data: userData,
      });
    } catch (error) {
      this.logger.error(`Error updating user with id ${id}:`, error);
      throw error;
    }
  }

  async delete(id: string): Promise<User> {
    try {
      return await this.databaseService.user.delete({
        where: { id },
      });
    } catch (error) {
      this.logger.error(`Error deleting user with id ${id}:`, error);
      throw error;
    }
  }
}
