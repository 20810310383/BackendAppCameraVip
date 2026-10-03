import nodemailer from 'nodemailer';

const APP_NAME = 'Camera Daily';
let transporter;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function emailIsConfigured() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function getTransporter() {
  if (!emailIsConfigured()) {
    throw new Error('EMAIL_USER hoặc EMAIL_PASS chưa được cấu hình.');
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }

  return transporter;
}

export async function verifyEmailTransport() {
  if (!emailIsConfigured()) return false;
  await getTransporter().verify();
  return true;
}

export async function sendPasswordResetOtp({ to, fullName, otp }) {
  const safeName = escapeHtml(fullName || 'bạn');
  const safeOtp = escapeHtml(otp);

  return getTransporter().sendMail({
    from: `"${APP_NAME}" <${process.env.EMAIL_USER}>`,
    to,
    subject: `${safeOtp} là mã xác minh đặt lại mật khẩu ${APP_NAME}`,
    text: `Xin chào ${fullName || 'bạn'},\n\nMã OTP đặt lại mật khẩu ${APP_NAME} của bạn là: ${otp}\nMã có hiệu lực trong 5 phút. Không chia sẻ mã này với bất kỳ ai.\n\nNếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.`,
    html: `
      <div style="margin:0;padding:32px 16px;background:#090b0c;font-family:Arial,sans-serif;color:#f8fafc">
        <div style="max-width:520px;margin:0 auto;overflow:hidden;border:1px solid #303638;border-radius:22px;background:#121718">
          <div style="padding:28px 28px 20px;background:linear-gradient(135deg,#332813,#171b1c)">
            <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#eac56d">${APP_NAME.toUpperCase()}</div>
            <h1 style="margin:10px 0 0;font-size:26px;line-height:34px;color:#fff2cc">Đặt lại mật khẩu</h1>
          </div>
          <div style="padding:26px 28px 30px">
            <p style="margin:0;color:#c5cbce;font-size:15px;line-height:23px">Xin chào <strong style="color:#ffffff">${safeName}</strong>,</p>
            <p style="margin:12px 0 0;color:#aeb6b9;font-size:14px;line-height:22px">Nhập mã xác minh dưới đây trong ứng dụng Camera Daily:</p>
            <div style="margin:24px 0;padding:18px;text-align:center;border:1px solid #715a25;border-radius:16px;background:#1b1a14;font-size:34px;font-weight:800;letter-spacing:12px;color:#f1ca70">${safeOtp}</div>
            <p style="margin:0;color:#aeb6b9;font-size:13px;line-height:21px">Mã có hiệu lực trong <strong style="color:#f1ca70">5 phút</strong>. Vì lý do bảo mật, vui lòng không chia sẻ mã này với bất kỳ ai.</p>
            <p style="margin:18px 0 0;color:#778185;font-size:12px;line-height:19px">Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này. Mật khẩu hiện tại của bạn vẫn an toàn.</p>
          </div>
        </div>
      </div>
    `,
  });
}
