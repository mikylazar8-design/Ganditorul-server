// Ganditorul - trimite codul de verificare prin Resend (fetch simplu, fara SDK).
// Necesita RESEND_API_KEY (variabila de mediu, setata in Render sub Environment).
//
// Domeniul ganditorul.the300game.com e verificat in Resend (DKIM+SPF, 2026-09-13) -
// trimitem de pe el, nu de pe adresa comuna de test onboarding@resend.dev (Gmail o
// arunca tacut, fara nicio eroare vizibila - vezi PROGRESS.md pt. investigatia completa).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.RESEND_FROM || 'Gânditorul <noreply@ganditorul.the300game.com>';

export async function sendVerificationCode(email, code) {
  if (!RESEND_API_KEY) {
    console.warn(
      `RESEND_API_KEY nu e setat - codul de verificare pentru ${email} NU a fost trimis pe email. ` +
      `Cod (doar pt. testare locala, vezi consola serverului): ${code}`
    );
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [email],
      subject: 'Codul tău de verificare Gânditorul',
      text: `Codul tău de verificare este: ${code}\n\nExpiră în 15 minute.`,
      html: `<p>Codul tău de verificare este: <b style="font-size:20px">${code}</b></p><p>Expiră în 15 minute.</p>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend a refuzat trimiterea emailului (${res.status}): ${body}`);
  }
}
