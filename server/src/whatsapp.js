// WhatsApp Cloud API sender (Meta). Needs WA_TOKEN and WA_PHONE_ID; without them it logs only.
// NOTE: outside the 24h customer-service window Meta requires an approved template message.
export function whatsappSender({ token, phoneId, template } = {}) {
  if (!token || !phoneId) return { async send(phone, text) { console.log(`[whatsapp:stub] -> ${phone}: ${text}`); } };
  return {
    async send(phone, text) {
      const to = String(phone).replace(/\D/g, '');
      const body = template
        ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } }
        : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
      const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`whatsapp send failed: ${r.status}`);
    },
  };
}
