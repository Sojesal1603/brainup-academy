'use client';

import { useMemo, useState } from 'react';
import {
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  HardDriveDownload,
  Link2,
  Search,
} from 'lucide-react';
import clsx from 'clsx';

export interface MoodleMaterialItem {
  id: string;
  name: string;
  sectionName: string;
  courseName: string;
  moduleType: string;
  mimeType: string | null;
  sizeBytes: number;
  modifiedAtIso: string | null;
  /** Tiene archivo descargable (el token lo pone el servidor). */
  hasFile: boolean;
  webUrl: string | null;
  /** Ya está copiado en el ordenador: se abre sin conexión. */
  downloaded: boolean;
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TYPE_LABELS: Record<string, string> = {
  resource: 'Archivo',
  folder: 'Carpeta',
  url: 'Enlace',
  page: 'Página',
  book: 'Libro',
  forum: 'Foro',
  quiz: 'Cuestionario',
};

/**
 * Apuntes que el profesor ha subido a Moodle, ordenados por curso y tema.
 * El archivo se pide a `/api/moodle/file/<id>`: el token nunca viaja al navegador.
 */
export default function MoodleMaterialsPanel({ materials }: { materials: MoodleMaterialItem[] }) {
  const [course, setCourse] = useState<string>('__all');
  const [query, setQuery] = useState('');

  const courses = useMemo(() => {
    const names = new Set(materials.map((material) => material.courseName));
    return [...names].sort((a, b) => a.localeCompare(b, 'es'));
  }, [materials]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return materials.filter((material) => {
      if (course !== '__all' && material.courseName !== course) return false;
      if (!needle) return true;
      return `${material.name} ${material.sectionName}`.toLowerCase().includes(needle);
    });
  }, [materials, course, query]);

  const sections = useMemo(() => {
    const map = new Map<string, MoodleMaterialItem[]>();
    for (const material of filtered) {
      const key = `${material.courseName}||${material.sectionName}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(material);
    }
    return [...map.entries()];
  }, [filtered]);

  const downloaded = materials.filter((material) => material.downloaded).length;

  if (materials.length === 0) {
    return (
      <div className="rounded-2xl glass-card p-6">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-100">
          <FolderOpen className="h-4 w-4 text-blue-400" />
          Apuntes de Moodle
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          Todavía no hay apuntes de Moodle indexados. Conecta tu Moodle en{' '}
          <a href="/ajustes" className="font-semibold text-emerald-400 hover:text-emerald-300">
            Ajustes
          </a>{' '}
          (dirección + token de Web Services) y lo que suba tu profesor aparecerá aquí, con su tema y su
          archivo.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-2xl glass-card p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-100">
            <FolderOpen className="h-4 w-4 text-blue-400" />
            Apuntes de Moodle
          </h3>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            {materials.length} recursos · {courses.length} cursos
            {downloaded > 0 ? ` · ${downloaded} ya en tu ordenador` : ''}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar apunte o tema"
              className="w-full rounded-xl border border-slate-800 bg-[#080d18] py-2 pl-9 pr-3 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none sm:w-56"
            />
          </div>
          <select
            value={course}
            onChange={(event) => setCourse(event.target.value)}
            className="rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
          >
            <option value="__all">Todos los cursos</option>
            {courses.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-4">
        {sections.map(([key, items]) => {
          const [courseName, sectionName] = key.split('||');
          return (
            <div key={key} className="space-y-2">
              <div className="flex items-baseline justify-between gap-3 border-b border-slate-800 pb-1.5">
                <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-blue-300">
                  {sectionName}
                </p>
                <p className="shrink-0 truncate font-mono text-[10px] text-slate-500">{courseName}</p>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {items.map((material) => {
                  const isLink = !material.hasFile;
                  const href = isLink ? material.webUrl : `/api/moodle/file/${material.id}`;
                  return (
                    <div
                      key={material.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        {isLink ? (
                          <Link2 className="h-4 w-4 shrink-0 text-slate-500" />
                        ) : (
                          <FileText className="h-4 w-4 shrink-0 text-emerald-400" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-slate-200">{material.name}</p>
                          <p className="truncate font-mono text-[10px] text-slate-500">
                            {TYPE_LABELS[material.moduleType] ?? material.moduleType}
                            {formatSize(material.sizeBytes) ? ` · ${formatSize(material.sizeBytes)}` : ''}
                            {material.downloaded ? ' · en tu ordenador' : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        {material.hasFile && (
                          <a
                            href={`/api/moodle/file/${material.id}?download=1`}
                            title="Descargar"
                            className="rounded-lg border border-slate-700 p-1.5 text-slate-400 transition-all hover:border-emerald-500/40 hover:text-emerald-300"
                          >
                            <HardDriveDownload className="h-3.5 w-3.5" />
                          </a>
                        )}
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className={clsx(
                              'flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-all',
                              isLink
                                ? 'border-slate-700 text-slate-300 hover:border-blue-500/40 hover:text-blue-300'
                                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                            )}
                          >
                            {isLink ? <ExternalLink className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                            <span>{isLink ? 'Moodle' : 'Abrir'}</span>
                          </a>
                        ) : (
                          <span className="text-[10px] text-slate-500">sin archivo</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {sections.length === 0 && (
          <p className="text-xs text-slate-500">Ningún apunte coincide con esa búsqueda.</p>
        )}
      </div>
    </div>
  );
}
