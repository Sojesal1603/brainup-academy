import clsx from 'clsx';
import { Award, CheckCircle2 } from 'lucide-react';
import {
  CHALLENGE_KINDS,
  CHALLENGE_STATUS_META,
  challengeProgressTone,
  describeProgress,
  isChallengeKind,
  isChallengeStatus,
  type ChallengeStatus,
} from '@/lib/challenges';

/**
 * Un reto de la semana, con lo que llevas hecho de él.
 *
 * El progreso no llega calculado desde el motor de cierre: llega como número
 * (`current`) y se pinta aquí con `describeProgress`, la misma función que usan
 * los demás sitios. Así el texto («12/20», «340/600 min») no puede decir una cosa
 * mientras la barra dice otra.
 */

export interface ChallengeCardData {
  id: string;
  kind: string;
  title: string;
  description: string;
  target: number;
  unit: string;
  rewardXp: number;
  status: string;
  subjectName: string | null;
}

interface ChallengeCardProps {
  challenge: ChallengeCardData;
  /** Cuánto llevas hecho esta semana, en la unidad del reto. */
  current: number;
}

export default function ChallengeCard({ challenge, current }: ChallengeCardProps) {
  const kindMeta = isChallengeKind(challenge.kind) ? CHALLENGE_KINDS[challenge.kind] : null;
  const status: ChallengeStatus = isChallengeStatus(challenge.status) ? challenge.status : 'active';
  const statusMeta = CHALLENGE_STATUS_META[status];

  const progress = describeProgress(challenge.target, challenge.unit, current);
  const tone = challengeProgressTone(progress.percent, progress.met);

  const barColor = progress.met
    ? 'bg-emerald-500'
    : progress.percent >= 70
      ? 'bg-sky-500'
      : progress.percent >= 35
        ? 'bg-amber-500'
        : 'bg-slate-600';

  return (
    <div
      className={clsx(
        'p-5 rounded-2xl border space-y-3 transition-colors',
        progress.met ? 'bg-emerald-500/5 border-emerald-500/30' : 'glass-card border-white/10'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={clsx(
              'text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border',
              kindMeta ? kindMeta.badgeColor : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
            )}
          >
            {kindMeta?.label ?? challenge.kind}
          </span>
          <span
            className={clsx(
              'text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border',
              statusMeta.badgeColor
            )}
          >
            {statusMeta.label}
          </span>
          {challenge.subjectName && (
            <span className="text-[10px] text-slate-500 font-mono">{challenge.subjectName}</span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0 text-[11px] font-mono text-emerald-400/90">
          <Award className="w-3.5 h-3.5" />
          <span>+{challenge.rewardXp} XP</span>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
          {progress.met && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
          <span>{challenge.title}</span>
        </h3>
        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{challenge.description}</p>
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between items-baseline text-[11px]">
          <span className={clsx('font-semibold', tone.className)}>{tone.label}</span>
          <span className="font-mono text-slate-300">{progress.label}</span>
        </div>
        <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
          <div
            className={clsx('h-full rounded-full transition-all duration-500', barColor)}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>
    </div>
  );
}
