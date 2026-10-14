import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';

const DEFAULT_GOOGLE_CLIENT_ID =
  '287748496954-4pivlnmvoeap2m1aume0hl5ka8bosnk8.apps.googleusercontent.com';

function normalizeEmail(raw: string | undefined | null): string {
  const e = (raw || '').trim();
  if (!e) throw new BadRequestException('Email is required');
  return e.toLowerCase();
}

function normalizeName(raw: string | undefined | null): string {
  return (raw || '').trim();
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClientId: string;
  private readonly googleClient: OAuth2Client | null;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService,
    private configService: ConfigService,
  ) {
    this.googleClientId =
      this.configService.get<string>('GOOGLE_CLIENT_ID') ||
      DEFAULT_GOOGLE_CLIENT_ID;
    this.googleClient = this.googleClientId
      ? new OAuth2Client(this.googleClientId)
      : null;
  }

  async register(
    name: string,
    fullName: string,
    email: string,
    password: string,
    role?: string,
  ) {
    try {
      const normEmail = normalizeEmail(email);
      const displayName = normalizeName(name);
      const legalName = normalizeName(fullName);

      // same email ok as organizer + vendor
      const userRole = role === 'VENDOR' ? 'VENDOR' : 'ORGANIZER';
      const existingUser = await this.prisma.user.findFirst({
        where: {
          email: { equals: normEmail, mode: 'insensitive' },
          role: userRole,
        },
      });

      const passwordHash = await bcrypt.hash(password, 10);
      let user;
      if (existingUser) {
        // fill password if role row had none (e.g. Google)
        if (!existingUser.passwordHash) {
          user = await this.prisma.user.update({
            where: { id: existingUser.id },
            data: {
              firstName: displayName || existingUser.firstName,
              lastName: legalName || existingUser.lastName,
              passwordHash,
              emailVerified: true,
              role: userRole,
            },
          });
        } else {
          throw new ConflictException(
            userRole === 'VENDOR'
              ? 'This email is already registered as a vendor.'
              : 'This email is already registered.',
          );
        }
      } else {
        user = await this.prisma.user.create({
          data: {
            email: normEmail,
            firstName: displayName || null,
            lastName: legalName || null,
            passwordHash,
            emailVerified: true,
            role: userRole,
          },
        });
      }

      // create vendor row on vendor signup
      if (userRole === 'VENDOR') {
        const existingVendor = await this.prisma.vendor.findUnique({
          where: { userId: user.id },
        });

        if (!existingVendor) {
          await this.prisma.vendor.create({
            data: {
              userId: user.id,
              businessName: displayName || 'Unnamed Business',
              email: normEmail,
              category: 'OTHER',
            },
          });

          user = await this.prisma.user.update({
            where: { id: user.id },
            data: { onboardingStatus: 'IN_PROGRESS' },
          });
        }
      }

      const payload = {
        sub: user.id,
        email: user.email,
        role: user.role,
        onboardingStatus: user.onboardingStatus,
      };
      const token = this.jwtService.sign(payload);

      const result = {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        },
        token,
      };

      return result;
    } catch (e: any) {
      console.error('❌ Registration service error:', e);
      console.error('❌ Error code:', e?.code);
      console.error('❌ Error message:', e?.message);

      if (e?.code === 'P2002') {
        console.log('❌ Duplicate email+role error');
        const userRole = role === 'VENDOR' ? 'VENDOR' : 'ORGANIZER';
        throw new ConflictException(
          userRole === 'VENDOR'
            ? 'This email is already registered as a vendor.'
            : 'This email is already registered.',
        );
      }
      throw e;
    }
  }

  async login(email: string, password: string, role?: string) {
    try {
      const normEmail = normalizeEmail(email);
      // organizer vs vendor account
      const loginRole = role === 'VENDOR' ? 'VENDOR' : 'ORGANIZER';

      const user = await this.prisma.user.findFirst({
        where: {
          email: { equals: normEmail, mode: 'insensitive' },
          role: loginRole,
        },
      });

      // vendor login needs a vendor row
      if (!user) {
        if (loginRole === 'VENDOR') {
          const anyUserForEmail = await this.prisma.user.findFirst({
            where: { email: { equals: normEmail, mode: 'insensitive' } },
          });
          if (anyUserForEmail && anyUserForEmail.role !== 'VENDOR') {
            throw new UnauthorizedException(
              'Vendor account does not exist. Please complete vendor onboarding first.',
            );
          }
        }
        throw new UnauthorizedException('Invalid credentials');
      }

      if (!user.passwordHash) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

      if (!isPasswordValid) {
        throw new UnauthorizedException('Invalid credentials');
      }

      // blocked → reject
      if (user.isBlocked) {
        const blockMessage = user.blockReason
          ? `Your account has been blocked. Reason: ${user.blockReason}`
          : 'Your account has been blocked.';
        throw new UnauthorizedException(blockMessage);
      }

      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const payload = {
        sub: user.id,
        email: user.email,
        role: user.role,
        onboardingStatus: user.onboardingStatus,
      };
      const token = this.jwtService.sign(payload);

      return {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        },
        token,
      };
    } catch (error) {
      console.error('❌ Login error:', error);
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      // don't leak internals
      throw new UnauthorizedException('Login failed');
    }
  }

  async loginWithGoogle(idToken: string, role?: string) {
    if (!idToken) {
      throw new BadRequestException('idToken is required');
    }

    if (!this.googleClientId || !this.googleClient) {
      throw new BadRequestException(
        'Google auth is not configured on the server',
      );
    }

    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: this.googleClientId,
      });
      const payload = ticket.getPayload();

      if (!payload?.email) {
        throw new UnauthorizedException('Google token missing email');
      }

      const email = payload.email.toLowerCase();
      const firstName =
        (payload.given_name || payload.name || '').split(' ')[0] || null;
      const lastName =
        payload.family_name ||
        (payload.name
          ? payload.name.replace(firstName || '', '').trim()
          : null);
      const userRole = role === 'VENDOR' ? 'VENDOR' : 'ORGANIZER';

      let user = await this.prisma.user.findFirst({
        where: {
          email: { equals: email, mode: 'insensitive' },
          role: userRole,
        },
      });

      if (!user) {
        user = await this.prisma.user.create({
          data: {
            email,
            firstName,
            lastName,
            emailVerified: true,
            role: userRole,
            onboardingStatus: userRole === 'VENDOR' ? 'IN_PROGRESS' : 'NONE',
          },
        });

        if (userRole === 'VENDOR') {
          await this.prisma.vendor.create({
            data: {
              userId: user.id,
              businessName: firstName || 'Unnamed Business',
              email,
              category: 'OTHER',
              googleVerificationStatus: 'PENDING',
            },
          });
        }
      } else {
        // blocked → reject Google too
        if (user.isBlocked) {
          const blockMessage = user.blockReason
            ? `Your account has been blocked. Reason: ${user.blockReason}`
            : 'Your account has been blocked.';
          throw new UnauthorizedException(
            JSON.stringify({
              message: blockMessage,
              email: user.email,
              isBlocked: true,
            }),
          );
        }

        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            firstName: user.firstName || firstName,
            lastName: user.lastName || lastName,
            emailVerified: true,
            lastLoginAt: new Date(),
          },
        });
      }

      const jwtPayload = {
        sub: user.id,
        email: user.email,
        role: user.role,
        onboardingStatus: user.onboardingStatus,
      };
      const token = this.jwtService.sign(jwtPayload);

      return {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        },
        token,
      };
    } catch (error) {
      this.logger.error('❌ Google login failed', error);
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new UnauthorizedException('Google sign-in failed');
    }
  }

  async validateUser(payload: any) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      const userData = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        onboardingStatus: user.onboardingStatus,
        avatar: user.avatar,
      };

      return userData;
    } catch (error) {
      console.error('❌ validateUser error:', error);
      throw error;
    }
  }

  async updateProfile(userId: string, profileData: any, addressData: any) {
    try {
      const existing = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true },
      });
      const existingPrefs: any = existing?.preferences || {};

      const updateData: any = {
        firstName: profileData.firstName,
        lastName: profileData.lastName,
        // extra profile fields live in preferences
        preferences: {
          ...existingPrefs,
          profileData: {
            ...(existingPrefs?.profileData || {}),
            ...profileData,
          },
          addressData: {
            ...(existingPrefs?.addressData || {}),
            ...addressData,
          },
        },
      };

      if (profileData.avatar) {
        updateData.avatar = profileData.avatar;
      }

      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });

      return {
        success: true,
        message: 'Profile updated successfully',
        user: updatedUser,
      };
    } catch (error) {
      console.error('Update profile error:', error);
      throw new BadRequestException('Failed to update profile');
    }
  }

  async getProfileData(userId: string) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          firstName: true,
          lastName: true,
          avatar: true,
          preferences: true,
        },
      });

      if (!user) {
        throw new BadRequestException('User not found');
      }

      const storedProfile = (user.preferences as any)?.profileData || {};
      const storedAddresses = (user.preferences as any)?.addressData || {};

      const profileData = {
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        avatar: user.avatar || '',
        homePhone: storedProfile.homePhone || '',
        cellPhone: storedProfile.cellPhone || '',
        jobTitle: storedProfile.jobTitle || '',
        company: storedProfile.company || '',
        suffix: storedProfile.suffix || '',
        websiteUrl: storedProfile.websiteUrl || '',
      };

      const emptyAddress = {
        address: '',
        address2: '',
        city: '',
        country: '',
        state: '',
        zip: '',
      };
      const addressData = {
        home: { ...emptyAddress, ...(storedAddresses.home || {}) },
        billing: { ...emptyAddress, ...(storedAddresses.billing || {}) },
        shipping: { ...emptyAddress, ...(storedAddresses.shipping || {}) },
        work: { ...emptyAddress, ...(storedAddresses.work || {}) },
      };

      return {
        success: true,
        profileData,
        addressData,
      };
    } catch (error) {
      console.error('Get profile data error:', error);
      throw new BadRequestException('Failed to get profile data');
    }
  }

  async testDatabaseConnection() {
    try {
      console.log('🔍 Testing database connection...');
      const userCount = await this.prisma.user.count();
      console.log('✅ Database connection successful. User count:', userCount);
      return { connected: true, userCount };
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw error;
    }
  }

  async requestPasswordReset(email: string) {
    try {
      const normEmail = normalizeEmail(email);

      const user = await this.prisma.user.findFirst({
        where: { email: { equals: normEmail, mode: 'insensitive' } },
      });

      // same message whether email exists
      if (!user || !user.passwordHash) {
        return {
          message: 'If this email exists, a password reset link has been sent.',
        };
      }

      const resetToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto
        .createHash('sha256')
        .update(resetToken)
        .digest('hex');

      const passwordResetExpires = new Date(Date.now() + 1000 * 60 * 15);

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetToken: hashedToken,
          passwordResetExpires: passwordResetExpires,
        },
      });

      const frontendUrl =
        this.configService.get<string>('FRONTEND_URL') ||
        'http://localhost:3000';
      const resetURL = `${frontendUrl}/reset-password?token=${resetToken}`;

      const emailSent = await this.mailService.sendResetEmail(
        user.email,
        resetURL,
      );

      if (!emailSent) {
        this.logger.error(
          '❌ Email sending failed - password reset link not sent',
        );
        throw new BadRequestException(
          'Failed to send password reset email. Please contact support or try again later.',
        );
      }

      return {
        message:
          'If this email exists, a password reset link has been sent to your email.',
      };
    } catch (error) {
      console.error('❌ Request password reset error:', error);
      // same message on error (no email leak)
      return {
        message: 'If this email exists, a password reset link has been sent.',
      };
    }
  }

  async resetPassword(token: string, newPassword: string) {
    try {
      if (!token || !newPassword) {
        throw new BadRequestException('Token and password are required');
      }

      if (newPassword.length < 6) {
        throw new BadRequestException(
          'Password must be at least 6 characters long',
        );
      }

      const hashedToken = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

      // valid, unexpired reset token
      const user = await this.prisma.user.findFirst({
        where: {
          passwordResetToken: hashedToken,
          passwordResetExpires: {
            gt: new Date(),
          },
        },
      });

      if (!user) {
        throw new BadRequestException('Token is invalid or has expired');
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordResetToken: null,
          passwordResetExpires: null,
        },
      });

      return { message: 'Password has been successfully reset' };
    } catch (error) {
      console.error('❌ Reset password error:', error);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to reset password');
    }
  }

  async deleteAccount(userId: string, password: string) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, passwordHash: true },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (!user.passwordHash) {
        throw new BadRequestException(
          'Cannot delete account. Please contact support.',
        );
      }

      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
      if (!isPasswordValid) {
        throw new UnauthorizedException('Invalid password');
      }

      // delete user + related rows in one tx
      await this.prisma.$transaction(
        async (tx) => {
          const events = await tx.event.findMany({
            where: { organizerId: userId },
            select: { id: true },
          });
          const eventIds = events.map((e) => e.id);

          if (eventIds.length > 0) {
            const rfqs = await tx.rFQ.findMany({
              where: { eventId: { in: eventIds } },
              select: { id: true },
            });
            const rfqIds = rfqs.map((r) => r.id);
            if (rfqIds.length > 0) {
              await tx.proposal.deleteMany({
                where: { rfqId: { in: rfqIds } },
              });
            }
            await tx.rFQ.deleteMany({ where: { eventId: { in: eventIds } } });
            await tx.rFQ.deleteMany({ where: { organizerId: userId } });
          }

          if (eventIds.length > 0) {
            await tx.eventService.deleteMany({
              where: { eventId: { in: eventIds } },
            });
            await tx.eventVendor.deleteMany({
              where: { eventId: { in: eventIds } },
            });
          }

          if (eventIds.length > 0) {
            const eventBookings = await tx.booking.findMany({
              where: { eventId: { in: eventIds } },
              select: { id: true },
            });
            const bookingIds = eventBookings.map((b) => b.id);
            if (bookingIds.length > 0) {
              await tx.ticket.deleteMany({
                where: { bookingId: { in: bookingIds } },
              });
              await tx.travelBooking.deleteMany({
                where: { bookingId: { in: bookingIds } },
              });
            }
            await tx.booking.deleteMany({
              where: { eventId: { in: eventIds } },
            });
          }

          if (eventIds.length > 0) {
            await tx.eventAttendance.deleteMany({
              where: { eventId: { in: eventIds } },
            });
            await tx.eventChatMessage.deleteMany({
              where: { eventId: { in: eventIds } },
            });
            await tx.review.deleteMany({
              where: { eventId: { in: eventIds } },
            });
          }

          if (eventIds.length > 0) {
            await tx.event.deleteMany({ where: { organizerId: userId } });
          }

          await tx.notification.deleteMany({ where: { userId } });
          await tx.eventChatMessage.deleteMany({ where: { userId } });
          await tx.eventAttendance.deleteMany({ where: { userId } });
          await tx.review.deleteMany({ where: { reviewerId: userId } });
          await tx.serviceBid.deleteMany({ where: { userId } });
          await tx.travelBookingItem.deleteMany({ where: { userId } });
          await tx.quoteRequest.deleteMany({ where: { userId } });

          const userBookings = await tx.booking.findMany({ where: { userId } });
          const userBookingIds = userBookings.map((b) => b.id);
          if (userBookingIds.length > 0) {
            await tx.ticket.deleteMany({
              where: { bookingId: { in: userBookingIds } },
            });
            await tx.travelBooking.deleteMany({
              where: { bookingId: { in: userBookingIds } },
            });
          }
          await tx.booking.deleteMany({ where: { userId } });

          await tx.workOrder.deleteMany({ where: { organizerId: userId } });
          await tx.payout.deleteMany({ where: { organizerId: userId } });

          await tx.vendor.deleteMany({ where: { userId } });

          await tx.user.delete({ where: { id: userId } });
        },
        {
          timeout: 30000,
        },
      );

      this.logger.log(`User account deleted: ${user.email} (${userId})`);

      return {
        success: true,
        message: 'Account deleted successfully',
      };
    } catch (error: any) {
      this.logger.error('❌ Delete account error:', error);
      this.logger.error('❌ Delete account error message:', error?.message);
      this.logger.error('❌ Delete account error stack:', error?.stack);

      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      const errorMessage =
        error?.message || error?.toString() || 'Unknown error occurred';
      this.logger.error('❌ Delete account error details:', errorMessage);
      throw new BadRequestException(
        `Failed to delete account: ${errorMessage}`,
      );
    }
  }

  // blocked user requests unblock
  async requestUnblock(email: string, reason: string) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('Reason is required');
    }

    if (!email || !email.trim()) {
      throw new BadRequestException('Email is required');
    }

    const normEmail = normalizeEmail(email);
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: normEmail, mode: 'insensitive' } },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isBlocked) {
      throw new BadRequestException('Your account is not blocked');
    }

    if (user.unblockRequestStatus === 'PENDING') {
      throw new BadRequestException(
        'You already have a pending unblock request',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        unblockRequestReason: reason.trim(),
        unblockRequestStatus: 'PENDING',
      },
    });

    return { success: true, message: 'Unblock request submitted successfully' };
  }
}
