import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

@Controller()
export class AppController {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  @Get('users')
  async listUsers() {
    return this.users.find();
  }

  @Post('users')
  async createUser(@Body() body: { name: string }) {
    return this.users.save(this.users.create(body));
  }

  @Get('boom')
  boom() {
    throw new BadRequestException('deliberate test exception');
  }

  // Deliberately N+1 — fetches every user, then re-fetches each one by id in
  // a loop instead of one query. Demonstrates Wolter's duplicate-query
  // detection in the trace waterfall: the per-id queries normalize to the
  // same label ("... WHERE id = ?"), so they show up as one repeated query.
  @Get('orders')
  async orders() {
    const users = await this.users.find();
    const rehydrated = [];
    for (const u of users) {
      rehydrated.push(await this.users.findOne({ where: { id: u.id } }));
    }
    return rehydrated;
  }
}
