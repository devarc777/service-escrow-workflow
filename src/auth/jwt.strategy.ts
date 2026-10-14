import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private authService: AuthService,
  ) {
    const jwtSecret =
      configService.get<string>('JWT_SECRET') || 'your-secret-key';

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        // prefer Bearer (per-tab token)
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        // else cookies
        (request) => {
          const cookies = (request as any)?.cookies;
          if (cookies) {
            // pick cookie from path / x-auth-context
            const url = request?.url || '';
            const isVendorEndpoint =
              url.includes('/vendors/') || url.includes('/vendor/');
            const preferVendor =
              isVendorEndpoint ||
              (request as any)?.headers?.['x-auth-context'] === 'vendor';
            const preferUser =
              (request as any)?.headers?.['x-auth-context'] === 'user';

            if (preferVendor && cookies.vendorToken) {
              return cookies.vendorToken;
            }

            if (preferUser && cookies.userToken) {
              return cookies.userToken;
            }

            // /auth/me: don't mix role cookies
            if (url.includes('/auth/me')) {
              if (preferVendor && cookies.vendorToken) {
                return cookies.vendorToken;
              }
              if (!preferVendor && cookies.userToken) {
                return cookies.userToken;
              }
              return null;
            }

            // default: matching role only
            if (preferVendor) {
              if (cookies.vendorToken) return cookies.vendorToken;
            } else if (cookies.userToken) {
              return cookies.userToken;
            }
            if (cookies.token) return cookies.token; // legacy
            return null;
          }

          // parse Cookie header fallback
          const cookieHeader: string | undefined = request?.headers?.cookie;
          if (!cookieHeader) return null;

          const url = request?.url || '';
          const isVendorEndpoint =
            url.includes('/vendors/') || url.includes('/vendor/');
          const preferVendor =
            isVendorEndpoint ||
            (request as any)?.headers?.['x-auth-context'] === 'vendor';
          const preferUser =
            (request as any)?.headers?.['x-auth-context'] === 'user';
          const parts = cookieHeader.split(';');

          if (preferVendor) {
            for (const part of parts) {
              const trimmed = part.trim();
              const [key, ...rest] = trimmed.split('=');
              if (key === 'vendorToken') return rest.join('=');
            }
          }

          if (preferUser) {
            for (const part of parts) {
              const trimmed = part.trim();
              const [key, ...rest] = trimmed.split('=');
              if (key === 'userToken') return rest.join('=');
            }
          }

          if (url.includes('/auth/me')) {
            for (const part of parts) {
              const trimmed = part.trim();
              const [key, ...rest] = trimmed.split('=');
              if (preferVendor && key === 'vendorToken') return rest.join('=');
              if (!preferVendor && key === 'userToken') return rest.join('=');
            }
            return null;
          }

          for (const part of parts) {
            const trimmed = part.trim();
            const [key, ...rest] = trimmed.split('=');
            if (preferVendor && key === 'vendorToken') return rest.join('=');
            if (!preferVendor && key === 'userToken') return rest.join('=');
            if (key === 'token') return rest.join('=');
          }
          return null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  async validate(payload: any) {
    try {
      const user = await this.authService.validateUser(payload);
      return user;
    } catch (error) {
      console.error('❌ JWT Strategy validation failed:', error);
      throw error;
    }
  }
}
