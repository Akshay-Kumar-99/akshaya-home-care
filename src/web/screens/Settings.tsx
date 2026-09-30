import { useEffect, useState, type FormEvent } from 'react';
import type { BusinessSettings } from '../../shared/api-types.ts';
import { renderInvoiceMessage } from '../../shared/invoice-template.ts';
import { normalizeIndianMobile } from '../../shared/phone.ts';
import { istDateString } from '../../shared/dates.ts';
import { StepUpCancelled, useFeedback } from '../app/feedback.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Field, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError, isNetworkError } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import type { SettingsSection } from '../lib/settings-section.ts';
import { Team } from './Team.tsx';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One tile per settings section; future additions become new tiles here. */
const SECTIONS: Array<{ key: SettingsSection; title: string; description: string; icon: IconName }> = [
  { key: 'team', title: t.navTeam, description: t.settingsTeamDesc, icon: 'users' },
  { key: 'template', title: t.invoiceTemplate, description: t.settingsTemplateDesc, icon: 'receipt' },
];

/**
 * Master-only Settings (owner, 30 Sep 2026): a grid of square tiles, one per section. A tile
 * opens its section as its own page (/settings?section=…), so the browser's Back returns here.
 */
export function Settings({ section }: { section: SettingsSection | null }) {
  const open = SECTIONS.find((x) => x.key === section);
  if (!open) {
    return (
      <section className="page">
        <header className="page-head">
          <div>
            <h2 className="page-title">{t.navSettings}</h2>
            <p className="page-sub">{t.settingsPageIntro}</p>
          </div>
        </header>
        <div className="settings-tiles">
          {SECTIONS.map((x) => (
            <button key={x.key} type="button" className="settings-tile" onClick={() => navigate(`/settings?section=${x.key}`)}>
              <span className="settings-tile-icon">
                <Icon name={x.icon} size={26} />
              </span>
              <span className="settings-tile-title">{x.title}</span>
              <span className="settings-tile-desc">{x.description}</span>
              <Icon name="chevronRight" size={18} className="settings-tile-go" />
            </button>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="page">
      <header className="page-head">
        <div>
          <button type="button" className="link-button back-link" onClick={() => navigate('/settings')}>
            <Icon name="chevronLeft" size={16} />
            {t.navSettings}
          </button>
          <h2 className="page-title">{open.title}</h2>
        </div>
      </header>
      {open.key === 'team' ? <Team /> : <InvoiceTemplate />}
    </section>
  );
}

/**
 * Business settings printed on every invoice message: the Terms & Conditions link
 * (e.g. a Google Drive PDF) and the business phone. A live preview shows the result.
 */
function InvoiceTemplate() {
  const { toast, withStepUp } = useFeedback();
  const [saved, setSaved] = useState<BusinessSettings | null>(null);
  const [termsUrl, setTermsUrl] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<{ termsUrl?: string; phone?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<BusinessSettings>('/api/admin/settings')
      .then((s) => {
        setSaved(s);
        setTermsUrl(s.termsUrl ?? '');
        setPhone(s.officialPhone.replace(/^\+91/, ''));
      })
      .catch(() => toast({ text: t.somethingWrong, tone: 'error' }));
  }, [toast]);

  if (!saved) return <Skeleton lines={8} />;

  const url = termsUrl.trim();
  const phoneE164 = normalizeIndianMobile(phone);
  const today = istDateString();
  const preview = renderInvoiceMessage({
    customerName: 'Meena',
    invoiceNumber: 39830,
    invoiceDate: today,
    totalPaise: 230000,
    officialPhoneE164: phoneE164 ?? saved.officialPhone,
    applianceLabel: 'AC (split)',
    serviceDescription: 'Gas refilling',
    paymentMode: 'upi',
    warrantyUntil: addDays(today, 90),
    warrantyForInvoiceNumber: null,
    termsUrl: url || null,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: typeof errors = {};
    if (url && !/^https:\/\/\S+$/.test(url)) found.termsUrl = t.settingsInvalidUrl;
    if (!phoneE164) found.phone = t.invalidPhone;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const next = await withStepUp(() =>
        api<BusinessSettings>('/api/admin/settings', { method: 'PATCH', body: { termsUrl: url || null, officialPhone: phoneE164 } }),
      );
      setSaved(next);
      toast({ text: t.settingsSaved, tone: 'ok' });
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) {
        toast({ text: isNetworkError(err) ? t.offlineAction : err instanceof ApiError ? t.somethingWrong : t.somethingWrong, tone: 'error' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="page-sub">{t.settingsIntro}</p>
      <div className="settings-grid">
        <form className="section stack" onSubmit={submit} noValidate>
          <Field label={t.termsUrl} icon="receipt" error={errors.termsUrl} hint={t.termsHint}>
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://drive.google.com/file/d/…/view"
              value={termsUrl}
              onChange={(e) => setTermsUrl(e.target.value)}
            />
          </Field>
          {url && /^https:\/\/\S+$/.test(url) ? (
            <a className="btn btn-small btn-ghost settings-open" href={url} target="_blank" rel="noopener noreferrer">
              <Icon name="eye" size={16} />
              {t.openLink}
            </a>
          ) : null}
          <Field label={t.officialPhone} icon="phone" error={errors.phone}>
            <input type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <Icon name="check" size={18} />
            {t.save}
          </button>
        </form>
        <div className="section stack-sm">
          <h3 className="section-title">
            <Icon name="copy" size={16} /> {t.messagePreview}
          </h3>
          <pre className="message-preview">{preview}</pre>
        </div>
      </div>
    </div>
  );
}
