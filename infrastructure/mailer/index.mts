const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;

export async function sendMail(to: string, subject: string, text: string, html: string): Promise<void> {
    // Sin SMTP configurado (desarrollo) el correo se imprime en consola
    if (!SMTP_HOST) {
        console.log(`[mailer] SMTP no configurado. Correo para ${to}\n${subject}\n${text}`);
        return;
    }

    const { createTransport } = await import("nodemailer");
    const port = Number(SMTP_PORT || 587);
    const transport = createTransport({
        host: SMTP_HOST,
        port,
        secure: port === 465,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });

    await transport.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text, html });
}
