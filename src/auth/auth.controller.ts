import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Req,
  Res,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { Request, Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  private cookieOptions() {
    const isProd = process.env.NODE_ENV === 'production';
    return {
      httpOnly: true,
      secure: isProd, // needed with sameSite:'none'
      sameSite: isProd ? ('none' as const) : ('lax' as const),
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/', // must match so clearCookie works
    };
  }

  @Post('register')
  async register(
    @Body()
    body: {
      name: string;
      fullName: string;
      email: string;
      password: string;
      role?: string;
    },
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const result = await this.authService.register(
        body.name,
        body.fullName,
        body.email,
        body.password,
        body.role,
      );

      // role-specific auth cookie
      const cookieName =
        result.user.role === 'VENDOR' ? 'vendorToken' : 'userToken';
      const opts = this.cookieOptions();
      res.cookie(cookieName, result.token, opts);

      // also return token for per-tab storage
      return { user: result.user, token: result.token };
    } catch (error) {
      console.error('❌ Registration controller error:', error);
      console.error('❌ Registration error details:', error.message);
      throw error;
    }
  }

  @Post('login')
  async login(
    @Body() body: { email: string; password: string; role?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const result = await this.authService.login(
        body.email,
        body.password,
        body.role,
      );

      // role-specific auth cookie
      const cookieName = result.user.role === 'VENDOR' ? 'vendorToken' : 'userToken';
      const opts = this.cookieOptions();
      res.cookie(cookieName, result.token, opts);

      // also return token for per-tab storage
      return { user: result.user, token: result.token };
    } catch (error) {
      console.error('❌ Login controller error:', error);
      throw error;
    }
  }

  @Post('google')
  async loginWithGoogle(
    @Body() body: { idToken: string; role?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.loginWithGoogle(
      body.idToken,
      body.role,
    );

    const cookieName =
      result.user.role === 'VENDOR' ? 'vendorToken' : 'userToken';
    const opts = this.cookieOptions();
    res.cookie(cookieName, result.token, opts);

    // also return token for per-tab storage
    return { user: result.user, token: result.token };
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const opts = this.cookieOptions();
    const clearOpts = { ...opts, maxAge: 0 };

    const authContext = req.headers['x-auth-context'];
    if (authContext === 'vendor') {
      res.clearCookie('vendorToken', clearOpts);
      res.clearCookie('token', clearOpts);
      return { message: 'Logged out successfully' };
    }
    if (authContext === 'user') {
      res.clearCookie('userToken', clearOpts);
      res.clearCookie('token', clearOpts);
      return { message: 'Logged out successfully' };
    }

    // clear matching role cookie
    const user = (req as any).user;
    const userRole = user?.role;
    const cookies = (req as any)?.cookies || {};
    const authHeader = req.headers?.authorization;

    let tokenToClear: 'vendorToken' | 'userToken' | null = null;
    if (userRole) {
      tokenToClear = userRole === 'VENDOR' ? 'vendorToken' : 'userToken';
    } else if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString(),
        );
        tokenToClear = payload.role === 'VENDOR' ? 'vendorToken' : 'userToken';
      } catch {
        if (cookies.vendorToken) tokenToClear = 'vendorToken';
        else if (cookies.userToken) tokenToClear = 'userToken';
      }
    } else {
      if (cookies.vendorToken) tokenToClear = 'vendorToken';
      else if (cookies.userToken) tokenToClear = 'userToken';
    }

    if (tokenToClear === 'vendorToken') {
      res.clearCookie('vendorToken', clearOpts);
    } else if (tokenToClear === 'userToken') {
      res.clearCookie('userToken', clearOpts);
    }
    res.clearCookie('token', clearOpts);
    return { message: 'Logged out successfully' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Req() req: Request) {
    try {
      if (!req.user) {
        console.error('❌ /auth/me: No user found in request');
        throw new UnauthorizedException('No user found in request');
      }
      return req.user;
    } catch (error) {
      console.error('❌ /auth/me error:', error);
      throw error;
    }
  }

  @Post('update-profile')
  @UseGuards(JwtAuthGuard)
  async updateProfile(
    @Body() body: { userId: string; profileData: any; addressData: any },
    @Req() req: Request,
  ) {
    return this.authService.updateProfile(
      body.userId,
      body.profileData,
      body.addressData,
    );
  }

  @Get('profile/:userId')
  @UseGuards(JwtAuthGuard)
  async getProfileData(@Req() req: Request) {
    const userId = (req.params as any).userId;
    return this.authService.getProfileData(userId);
  }

  @Get('health')
  async healthCheck() {
    try {
      await this.authService.testDatabaseConnection();
      return { status: 'ok', message: 'Auth service is healthy' };
    } catch (error) {
      console.error('❌ Health check failed:', error);
      return {
        status: 'error',
        message: 'Auth service is unhealthy',
        error: error.message,
      };
    }
  }

  @Post('forgot-password')
  async requestPasswordReset(@Body('email') email: string) {
    return this.authService.requestPasswordReset(email);
  }

  @Post('reset-password')
  async resetPassword(@Body() body: { token: string; password: string }) {
    return this.authService.resetPassword(body.token, body.password);
  }

  @Post('delete-account')
  @UseGuards(JwtAuthGuard)
  async deleteAccount(
    @Body() body: { password: string },
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      if (!req.user || !req.user.id) {
        throw new UnauthorizedException('User not authenticated');
      }

      const result = await this.authService.deleteAccount(
        req.user.id,
        body.password,
      );

      const opts = this.cookieOptions();
      res.clearCookie('userToken', { secure: opts.secure, sameSite: opts.sameSite });
      res.clearCookie('vendorToken', { secure: opts.secure, sameSite: opts.sameSite });
      res.clearCookie('token', { secure: opts.secure, sameSite: opts.sameSite });

      return result;
    } catch (error: any) {
      console.error('❌ Delete account controller error:', error);
      console.error(
        '❌ Delete account controller error message:',
        error?.message,
      );
      console.error(
        '❌ Delete account controller error status:',
        error?.status,
      );

      if (error.status && error.response) {
        throw error;
      }

      const errorMessage = error?.message || 'Failed to delete account';
      throw new BadRequestException(errorMessage);
    }
  }

  @Post('request-unblock')
  async requestUnblock(@Body() body: { email: string; reason: string }) {
    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException('Reason is required');
    }
    if (!body.email || !body.email.trim()) {
      throw new BadRequestException('Email is required');
    }
    return this.authService.requestUnblock(body.email, body.reason);
  }
}
