import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private resend: Resend | null = null;
  private transporter: nodemailer.Transporter | null = null;

  constructor(private configService: ConfigService) {
    // Prefer SMTP (e.g. Brevo) via Nodemailer
    const smtpHost = this.configService.get<string>('SMTP_HOST');
    const smtpPort = this.configService.get<string>('SMTP_PORT');
    const smtpUser = this.configService.get<string>('SMTP_USER');
    const smtpPass = this.configService.get<string>('SMTP_PASS');

    if (smtpHost && smtpPort && smtpUser && smtpPass) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: Number(smtpPort),
        secure: Number(smtpPort) === 465, // true for SMTPS/465, false for STARTTLS/587
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });
      this.logger.log('✅ Using SMTP (Nodemailer) for email delivery');
    }

    // Configure Resend as optional fallback if SMTP is not available
    const resendApiKey = this.configService.get<string>('RESEND_API_KEY');
    if (resendApiKey && resendApiKey !== 'your-resend-api-key') {
      this.resend = new Resend(resendApiKey);
      this.logger.log('✅ Resend client configured (fallback)');
    }

    if (!this.transporter && !this.resend) {
      this.logger.error('❌ EMAIL CONFIGURATION REQUIRED!');
      this.logger.error(
        '❌ Configure SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) or RESEND_API_KEY in .env',
      );
    }
  }

  /**
   * Low-level email sender that prefers SMTP (Nodemailer) and falls back to Resend if configured.
   */
  private async sendEmail(
    recipientEmail: string,
    subject: string,
    html: string,
  ): Promise<boolean> {
    const fromEmail =
      this.configService.get<string>('FROM_EMAIL') || 'no-reply@evenzs.com';
    const fromName =
      this.configService.get<string>('FROM_NAME') || 'Evenzs';

    // Try SMTP first if configured
    if (this.transporter) {
      try {
        const info = await this.transporter.sendMail({
          from: `"${fromName}" <${fromEmail}>`,
          to: recipientEmail,
          subject,
          html,
        });
        this.logger.log(
          `✅ Email sent via SMTP to ${recipientEmail} (messageId: ${info.messageId})`,
        );
        return true;
      } catch (error) {
        this.logger.error(
          `❌ Failed to send email via SMTP to ${recipientEmail}, will try fallback if available`,
          error as any,
        );
      }
    }

    // Fallback to Resend if configured
    if (this.resend) {
      try {
        const { data, error } = await this.resend.emails.send({
          from: fromEmail,
          to: recipientEmail,
          subject,
          html,
        });

        if (error) {
          this.logger.error(
            `❌ Resend error while sending email to ${recipientEmail}:`,
            error,
          );
          return false;
        }

        this.logger.log(
          `✅ Email sent via Resend to ${recipientEmail} (messageId: ${data?.id})`,
        );
        return true;
      } catch (error) {
        this.logger.error(
          `❌ Exception while sending email via Resend to ${recipientEmail}:`,
          error as any,
        );
        return false;
      }
    }

    this.logger.error(
      `❌ No email transport configured. Failed to send email to ${recipientEmail}`,
    );
    return false;
  }

  async sendResetEmail(email: string, resetUrl: string): Promise<boolean> {
    this.logger.log(`📧 Sending password reset email to: ${email}`);

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
            line-height: 1.6; 
            color: #1e293b; 
            margin: 0;
            padding: 0;
            background-color: #f8fafc;
          }
          .email-container { 
            max-width: 600px; 
            margin: 0 auto; 
            background-color: #ffffff;
          }
          .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            color: #ffffff;
            margin: 0;
            font-size: 28px;
            font-weight: 700;
          }
          .content {
            padding: 40px 30px;
          }
          .button { 
            display: inline-block; 
            padding: 14px 32px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #ffffff !important; 
            text-decoration: none; 
            border-radius: 10px; 
            margin: 24px 0;
            font-weight: 600;
            font-size: 15px;
          }
          .link-box {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 16px;
            margin: 20px 0;
            word-break: break-all;
            font-size: 13px;
            color: #667eea;
          }
          .warning {
            background-color: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 16px;
            margin: 24px 0;
            border-radius: 4px;
          }
          .footer { 
            margin-top: 40px; 
            padding-top: 24px;
            border-top: 1px solid #e2e8f0;
            font-size: 13px; 
            color: #64748b;
            text-align: center;
          }
          @media only screen and (max-width: 600px) {
            .content {
              padding: 30px 20px;
            }
            .header {
              padding: 30px 20px;
            }
          }
        </style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <h1>Reset Your Password</h1>
          </div>
          <div class="content">
            <p style="font-size: 16px; margin-bottom: 20px;">Hello,</p>
            <p>You requested to reset your password for your Evenzs account. Click the button below to create a new password:</p>
            
            <div style="text-align: center;">
              <a href="${resetUrl}" class="button">Reset Password</a>
            </div>
            
            <p style="font-size: 14px; color: #64748b;">Or copy and paste this link into your browser:</p>
            <div class="link-box">${resetUrl}</div>
            
            <div class="warning">
              <p style="margin: 0; font-size: 14px; color: #92400e;">
                <strong>⚠️ Important:</strong> This link will expire in 15 minutes for security reasons.
              </p>
            </div>
            
            <p style="font-size: 14px; color: #64748b; margin-top: 24px;">
              If you didn't request this password reset, please ignore this email. Your password will remain unchanged.
            </p>
          </div>
          <div class="footer">
            <p style="margin: 0;">Best regards,<br><strong>The Evenzs Team</strong></p>
            <p style="margin: 8px 0 0 0; font-size: 12px;">This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail(email, 'Reset Your Password - Evenzs', htmlContent);
  }

  /**
   * Send a generic notification email (mirrors in-app notification to email).
   */
  async sendNotificationEmail(
    recipientEmail: string,
    subject: string,
    message: string,
  ): Promise<boolean> {
    if (!recipientEmail?.trim()) return false;
    this.logger.log(`📧 Sending notification email to: ${recipientEmail}`);
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1e293b; margin: 0; padding: 0; background-color: #f8fafc; }
          .container { max-width: 600px; margin: 0 auto; background: #fff; }
          .header { background: linear-gradient(135deg, #0B1A33 0%, #1e3a5f 100%); padding: 24px 30px; text-align: center; }
          .header h1 { color: #fff; margin: 0; font-size: 22px; font-weight: 600; }
          .content { padding: 28px 30px; }
          .message { background: #f0f9ff; border-left: 4px solid #2563eb; padding: 16px; border-radius: 6px; margin: 16px 0; white-space: pre-wrap; }
          .footer { padding: 20px 30px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header"><h1>Evenzs – Notification</h1></div>
          <div class="content">
            <p style="margin: 0 0 12px 0; font-weight: 600; font-size: 16px;">${subject}</p>
            <div class="message">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>
            <p style="font-size: 14px; color: #64748b;">You can view and manage this in your <a href="${this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'}/profile/my-events?tab=notifications">Notifications</a>.</p>
          </div>
          <div class="footer">Evenzs – Event Management. This is an automated message.</div>
        </div>
      </body>
      </html>
    `;
    return this.sendEmail(recipientEmail, subject, htmlContent);
  }

  /**
   * Email to external (scraped) vendor: someone requested a quote on Evenzs; sign up to view.
   * Same style as admin invite email — includes Evenzs benefits (Stripe, escrow, etc.).
   */
  async sendExternalVendorQuoteRequestEmail(
    recipientEmail: string,
    vendorName: string,
    signupClaimUrl: string,
  ): Promise<boolean> {
    if (!recipientEmail?.trim()) return false;
    this.logger.log(`📧 Sending external vendor quote request email to: ${recipientEmail}`);
    const subject = 'You have a quote request on Evenzs – sign up to view and respond';
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1e293b; margin: 0; padding: 0; background-color: #f8fafc; }
          .container { max-width: 600px; margin: 0 auto; background: #fff; }
          .header { background: linear-gradient(135deg, #0B1A33 0%, #1e3a5f 100%); padding: 24px 30px; text-align: center; }
          .header h1 { color: #fff; margin: 0; font-size: 22px; font-weight: 600; }
          .content { padding: 28px 30px; }
          .cta { display: inline-block; margin: 16px 0; padding: 14px 28px; background: #0B1A33; color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600; }
          .footer { padding: 20px 30px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
          .benefits { background: #f0f9ff; border-left: 4px solid #0ea5e9; padding: 16px 20px; margin: 20px 0; border-radius: 0 8px 8px 0; }
          .benefits ul { margin: 0; padding-left: 20px; }
          .benefits li { margin: 8px 0; color: #1e293b; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header"><h1>Evenzs</h1></div>
          <div class="content">
            <p style="margin: 0 0 12px 0; font-weight: 600; font-size: 16px;">Someone requested a quote from you on Evenzs</p>
            <p>Hi${vendorName ? ` ${vendorName}` : ''},</p>
            <p>A customer has submitted a quote request for your services on Evenzs — the event and vendor marketplace. Create a free vendor account to view the request and respond.</p>
            <div class="benefits">
              <p style="margin: 0 0 10px 0; font-weight: 600; font-size: 14px; color: #0c4a6e;">Why join Evenzs as a vendor?</p>
              <ul>
                <li><strong>Stripe-protected payments</strong> — Secure payments and payouts so you get paid safely.</li>
                <li><strong>Escrow for quotes &amp; work orders</strong> — Funds are held securely until work is completed.</li>
                <li><strong>Reach more customers</strong> — Get discovered by organizers and clients looking for your services.</li>
                <li><strong>Free to join</strong> — Create your vendor profile and start receiving quote requests.</li>
              </ul>
            </div>
            <p><a href="${signupClaimUrl}" class="cta">Sign up to view the request</a></p>
            <p style="font-size: 14px; color: #64748b;">This link will take you to sign up; after you create your account, you'll see the quote request in your Requests section.</p>
          </div>
          <div class="footer">Evenzs – Event &amp; Vendor Marketplace. This is an automated message.</div>
        </div>
      </body>
      </html>
    `;
    return this.sendEmail(recipientEmail, subject, htmlContent);
  }

  async sendBidNotificationEmail(
    recipientEmail: string,
    recipientName: string,
    vendorName: string,
    serviceTitle: string,
    bidAmount: number,
    currency: string,
    eventTitle: string,
    bidMessage?: string,
  ): Promise<boolean> {
    this.logger.log(`📧 Sending bid notification email to: ${recipientEmail}`);

    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(bidAmount);

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
            line-height: 1.6; 
            color: #1e293b; 
            margin: 0;
            padding: 0;
            background-color: #f8fafc;
          }
          .email-container { 
            max-width: 600px; 
            margin: 0 auto; 
            background-color: #ffffff;
          }
          .header {
            background: linear-gradient(135deg, #D4AF37 0%, #B8941F 100%);
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            color: #ffffff;
            margin: 0;
            font-size: 28px;
            font-weight: 700;
          }
          .content {
            padding: 40px 30px;
          }
          .info-box {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #e2e8f0;
          }
          .info-row:last-child {
            border-bottom: none;
          }
          .info-label {
            font-weight: 600;
            color: #64748b;
          }
          .info-value {
            color: #1e293b;
            font-weight: 500;
          }
          .amount-highlight {
            font-size: 24px;
            font-weight: 700;
            color: #D4AF37;
          }
          .button { 
            display: inline-block; 
            padding: 14px 32px; 
            background: linear-gradient(135deg, #D4AF37 0%, #B8941F 100%);
            color: #ffffff !important; 
            text-decoration: none; 
            border-radius: 10px; 
            margin: 24px 0;
            font-weight: 600;
            font-size: 15px;
          }
          .footer { 
            margin-top: 40px; 
            padding-top: 24px;
            border-top: 1px solid #e2e8f0;
            font-size: 13px; 
            color: #64748b;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <h1>New Bid Received! 🎉</h1>
          </div>
          <div class="content">
            <p style="font-size: 16px; margin-bottom: 20px;">Hello ${recipientName},</p>
            <p>Great news! You've received a new bid for your event service request.</p>
            
            <div class="info-box">
              <div class="info-row">
                <span class="info-label">Event:</span>
                <span class="info-value">${eventTitle}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Service:</span>
                <span class="info-value">${serviceTitle}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Vendor:</span>
                <span class="info-value">${vendorName}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Bid Amount:</span>
                <span class="info-value amount-highlight">${formattedAmount}</span>
              </div>
            </div>

            ${bidMessage ? `<p style="margin-top: 20px;"><strong>Message from vendor:</strong></p><p style="background-color: #f8fafc; padding: 16px; border-radius: 8px; font-style: italic;">${bidMessage}</p>` : ''}
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'}/events" class="button">View Bid Details</a>
            </div>
          </div>
          <div class="footer">
            <p style="margin: 0;">Best regards,<br><strong>The Evenzs Team</strong></p>
            <p style="margin: 8px 0 0 0; font-size: 12px;">This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail(
      recipientEmail,
      `New Bid Received - ${serviceTitle} - Evenzs`,
      htmlContent,
    );
  }

  async sendQuoteAcceptedEmail(
    recipientEmail: string,
    recipientName: string,
    vendorName: string,
    eventType: string,
    quoteAmount: number,
    currency: string,
    eventDate?: string,
    eventLocation?: string,
  ): Promise<boolean> {
    this.logger.log(`📧 Sending quote accepted email to: ${recipientEmail}`);

    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(quoteAmount);

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
            line-height: 1.6; 
            color: #1e293b; 
            margin: 0;
            padding: 0;
            background-color: #f8fafc;
          }
          .email-container { 
            max-width: 600px; 
            margin: 0 auto; 
            background-color: #ffffff;
          }
          .header {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            color: #ffffff;
            margin: 0;
            font-size: 28px;
            font-weight: 700;
          }
          .content {
            padding: 40px 30px;
          }
          .info-box {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #e2e8f0;
          }
          .info-row:last-child {
            border-bottom: none;
          }
          .info-label {
            font-weight: 600;
            color: #64748b;
          }
          .info-value {
            color: #1e293b;
            font-weight: 500;
          }
          .amount-highlight {
            font-size: 24px;
            font-weight: 700;
            color: #10b981;
          }
          .success-badge {
            background-color: #d1fae5;
            color: #065f46;
            padding: 12px 20px;
            border-radius: 8px;
            text-align: center;
            font-weight: 600;
            margin: 20px 0;
          }
          .button { 
            display: inline-block; 
            padding: 14px 32px; 
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: #ffffff !important; 
            text-decoration: none; 
            border-radius: 10px; 
            margin: 24px 0;
            font-weight: 600;
            font-size: 15px;
          }
          .footer { 
            margin-top: 40px; 
            padding-top: 24px;
            border-top: 1px solid #e2e8f0;
            font-size: 13px; 
            color: #64748b;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <h1>Quote Accepted! ✅</h1>
          </div>
          <div class="content">
            <p style="font-size: 16px; margin-bottom: 20px;">Hello ${recipientName},</p>
            <p>Great news! Your quote request has been accepted by the vendor.</p>
            
            <div class="success-badge">
              ✓ Quote Accepted Successfully
            </div>
            
            <div class="info-box">
              <div class="info-row">
                <span class="info-label">Event Type:</span>
                <span class="info-value">${eventType}</span>
              </div>
              ${
                eventDate
                  ? `<div class="info-row">
                <span class="info-label">Event Date:</span>
                <span class="info-value">${eventDate}</span>
              </div>`
                  : ''
              }
              ${
                eventLocation
                  ? `<div class="info-row">
                <span class="info-label">Location:</span>
                <span class="info-value">${eventLocation}</span>
              </div>`
                  : ''
              }
              <div class="info-row">
                <span class="info-label">Vendor:</span>
                <span class="info-value">${vendorName}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Accepted Quote:</span>
                <span class="info-value amount-highlight">${formattedAmount}</span>
              </div>
            </div>

            <p style="margin-top: 20px;">Your work order has been created and the vendor will begin preparing for your event. You'll receive updates as the work progresses.</p>
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'}/work-orders" class="button">View Work Order</a>
            </div>
          </div>
          <div class="footer">
            <p style="margin: 0;">Best regards,<br><strong>The Evenzs Team</strong></p>
            <p style="margin: 8px 0 0 0; font-size: 12px;">This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail(
      recipientEmail,
      `Quote Accepted - ${eventType} - Evenzs`,
      htmlContent,
    );
  }

  /**
   * Send admin invite-to-join-as-vendor email.
   */
  async sendVendorInviteEmail(recipientEmail: string): Promise<boolean> {
    if (!recipientEmail?.trim()) return false;
    this.logger.log(`📧 Sending vendor invite email to: ${recipientEmail}`);
    const frontendUrl = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/$/, '');
    const signupUrl = `${frontendUrl}/vendor/auth/signup`;
    const subject = "You're invited to join Evenzs as a vendor";
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1e293b; margin: 0; padding: 0; background-color: #f8fafc; }
          .container { max-width: 600px; margin: 0 auto; background: #fff; }
          .header { background: linear-gradient(135deg, #0B1A33 0%, #1e3a5f 100%); padding: 24px 30px; text-align: center; }
          .header h1 { color: #fff; margin: 0; font-size: 22px; font-weight: 600; }
          .content { padding: 28px 30px; }
          .cta { display: inline-block; margin: 16px 0; padding: 14px 28px; background: #0B1A33; color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600; }
          .footer { padding: 20px 30px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
          .benefits { background: #f0f9ff; border-left: 4px solid #0ea5e9; padding: 16px 20px; margin: 20px 0; border-radius: 0 8px 8px 0; }
          .benefits ul { margin: 0; padding-left: 20px; }
          .benefits li { margin: 8px 0; color: #1e293b; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header"><h1>Evenzs</h1></div>
          <div class="content">
            <p style="margin: 0 0 12px 0; font-weight: 600; font-size: 16px;">You're invited to join Evenzs as a vendor</p>
            <p>We'd like to invite you to join Evenzs — the event and vendor marketplace where you can list your services and connect with event organizers and customers.</p>
            <div class="benefits">
              <p style="margin: 0 0 10px 0; font-weight: 600; font-size: 14px; color: #0c4a6e;">Why join as a vendor?</p>
              <ul>
                <li><strong>Stripe-protected payments</strong> — Secure payments and payouts so you get paid safely.</li>
                <li><strong>Escrow for quotes &amp; work orders</strong> — Funds are held securely until work is completed.</li>
                <li><strong>Reach more customers</strong> — Get discovered by organizers and clients looking for your services.</li>
                <li><strong>Free to join</strong> — Create your vendor profile and start receiving quote requests.</li>
              </ul>
            </div>
            <p><a href="${signupUrl}" class="cta">Join as a vendor</a></p>
            <p style="font-size: 14px; color: #64748b;">Create your free vendor account to get started.</p>
          </div>
          <div class="footer">Evenzs – Event &amp; Vendor Marketplace. This is an automated message.</div>
        </div>
      </body>
      </html>
    `;
    return this.sendEmail(recipientEmail, subject, htmlContent);
  }

  async sendTicketPurchaseEmail(
    recipientEmail: string,
    recipientName: string,
    eventTitle: string,
    bookingNumber: string,
    tickets: Array<{ tier: string; quantity: number; price: number }>,
    totalAmount: number,
    currency: string,
    eventDate?: string,
    eventLocation?: string,
  ): Promise<boolean> {
    this.logger.log(`📧 ===== SENDING TICKET PURCHASE EMAIL =====`);
    this.logger.log(`📧 Recipient: ${recipientEmail}`);
    this.logger.log(`📧 Name: ${recipientName}`);
    this.logger.log(`📧 Event: ${eventTitle}`);
    this.logger.log(`📧 Booking: ${bookingNumber}`);

    const formattedTotal = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(totalAmount);

    const ticketsList = tickets
      .map((ticket) => {
        const ticketTotal = ticket.price * ticket.quantity;
        const formattedTicketTotal = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: currency || 'USD',
        }).format(ticketTotal);
        return `
        <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; margin: 12px 0;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong style="font-size: 16px;">${ticket.tier || 'General Admission'}</strong>
              <p style="margin: 4px 0 0 0; color: #64748b; font-size: 14px;">Quantity: ${ticket.quantity}</p>
            </div>
            <div style="text-align: right;">
              <strong style="font-size: 18px; color: #1e293b;">${formattedTicketTotal}</strong>
            </div>
          </div>
        </div>
      `;
      })
      .join('');

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
            line-height: 1.6; 
            color: #1e293b; 
            margin: 0;
            padding: 0;
            background-color: #f8fafc;
          }
          .email-container { 
            max-width: 600px; 
            margin: 0 auto; 
            background-color: #ffffff;
          }
          .header {
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            color: #ffffff;
            margin: 0;
            font-size: 28px;
            font-weight: 700;
          }
          .content {
            padding: 40px 30px;
          }
          .info-box {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #e2e8f0;
          }
          .info-row:last-child {
            border-bottom: none;
          }
          .info-label {
            font-weight: 600;
            color: #64748b;
          }
          .info-value {
            color: #1e293b;
            font-weight: 500;
          }
          .total-amount {
            font-size: 28px;
            font-weight: 700;
            color: #3b82f6;
            text-align: center;
            padding: 20px 0;
            border-top: 2px solid #e2e8f0;
            margin-top: 20px;
          }
          .success-badge {
            background-color: #dbeafe;
            color: #1e40af;
            padding: 12px 20px;
            border-radius: 8px;
            text-align: center;
            font-weight: 600;
            margin: 20px 0;
          }
          .button { 
            display: inline-block; 
            padding: 14px 32px; 
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            color: #ffffff !important; 
            text-decoration: none; 
            border-radius: 10px; 
            margin: 24px 0;
            font-weight: 600;
            font-size: 15px;
          }
          .footer { 
            margin-top: 40px; 
            padding-top: 24px;
            border-top: 1px solid #e2e8f0;
            font-size: 13px; 
            color: #64748b;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <h1>🎟️ Tickets Confirmed!</h1>
          </div>
          <div class="content">
            <p style="font-size: 16px; margin-bottom: 20px;">Hello ${recipientName},</p>
            <p>Thank you for your purchase! Your tickets have been confirmed.</p>
            
            <div class="success-badge">
              ✓ Booking Confirmed - ${bookingNumber}
            </div>
            
            <div class="info-box">
              <div class="info-row">
                <span class="info-label">Event:</span>
                <span class="info-value">${eventTitle}</span>
              </div>
              ${
                eventDate
                  ? `<div class="info-row">
                <span class="info-label">Date:</span>
                <span class="info-value">${eventDate}</span>
              </div>`
                  : ''
              }
              ${
                eventLocation
                  ? `<div class="info-row">
                <span class="info-label">Location:</span>
                <span class="info-value">${eventLocation}</span>
              </div>`
                  : ''
              }
              <div class="info-row">
                <span class="info-label">Booking Number:</span>
                <span class="info-value">${bookingNumber}</span>
              </div>
            </div>

            <h3 style="margin-top: 30px; margin-bottom: 15px;">Your Tickets:</h3>
            ${ticketsList}

            <div class="total-amount">
              Total: ${formattedTotal}
            </div>

            <p style="margin-top: 20px; font-size: 14px; color: #64748b;">
              Your tickets and QR codes are available in your account. You'll receive a separate email with your ticket details shortly.
            </p>
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'}/bookings" class="button">View My Tickets</a>
            </div>
          </div>
          <div class="footer">
            <p style="margin: 0;">Best regards,<br><strong>The Evenzs Team</strong></p>
            <p style="margin: 8px 0 0 0; font-size: 12px;">This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail(
      recipientEmail,
      `Tickets Confirmed - ${eventTitle} - Evenzs`,
      htmlContent,
    );
  }
}
