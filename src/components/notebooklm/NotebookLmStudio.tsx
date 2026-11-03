'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  ExternalLink,
  Copy,
  Check,
  BookOpen,
  Sparkles,
  Layers,
  ArrowRight,
  ShieldCheck,
  FileText,
  FileCheck2,
  CheckCircle2,
  ChevronRight,
  BookmarkPlus,
  Loader2,
  GraduationCap,
  Eye,
  Edit3,
  RotateCcw,
} from 'lucide-react';
import { NOTEBOOKLM_FLOWS, type NotebookLmFlow } from '@/lib/notebooklm';
import NoteRenderer from '@/components/apuntes/NoteRenderer';

interface TopicItem {
  id: string;
  title: string;
  unitNumber: number | null;
  status: string;
  teacherMethod: string | null;
}

interface SubjectItem {
  id: string;
  name: string;
  color: string;
  topics: TopicItem[];
}

interface NotebookLmStudioProps {
  subjects: SubjectItem[];
}

interface TransformedDraft {
  title: string;
  content: string;
  agentName: string;
  words: number;
  subjectName: string;
}

export default function NotebookLmStudio({ subjects }: NotebookLmStudioProps) {
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>(
    subjects[0]?.id || ''
  );

  const selectedSubject = useMemo(
    () => subjects.find((s) => s.id === selectedSubjectId) || subjects[0],
    [subjects, selectedSubjectId]
  );

  const [selectedTopicId, setSelectedTopicId] = useState<string>('');

  const activeTopic = useMemo(() => {
    if (!selectedSubject || !selectedSubject.topics.length) return null;
    return (
      selectedSubject.topics.find((t) => t.id === selectedTopicId) ||
      selectedSubject.topics[0]
    );
  }, [selectedSubject, selectedTopicId]);

  const [selectedFlowId, setSelectedFlowId] = useState<string>('esquema_fiel');
  const [copied, setCopied] = useState(false);

  // Raw paste area state
  const [rawContent, setRawContent] = useState('');
  const [customTitle, setCustomTitle] = useState('');

  // Catedrático AI transformation state
  const [isTransforming, setIsTransforming] = useState(false);
  const [transformedDraft, setTransformedDraft] = useState<TransformedDraft | null>(null);
  const [editMode, setEditMode] = useState(false);

  // Save to Notion state
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const selectedFlow = useMemo(
    () =>
      NOTEBOOKLM_FLOWS.find((f) => f.id === selectedFlowId) ||
      NOTEBOOKLM_FLOWS[0],
    [selectedFlowId]
  );

  const generatedPrompt = useMemo(() => {
    if (!selectedSubject || !activeTopic) return '';
    return selectedFlow.generatePrompt({
      subjectName: selectedSubject.name,
      topicTitle: activeTopic.title,
      unitNumber: activeTopic.unitNumber,
      teacherMethod: activeTopic.teacherMethod,
    });
  }, [selectedSubject, activeTopic, selectedFlow]);

  const handleCopyPrompt = async () => {
    if (!generatedPrompt) return;
    try {
      await navigator.clipboard.writeText(generatedPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  // 1. Enviar a transformar con el Catedrático IA de la materia
  const handleTransformWithCatedratico = async () => {
    if (!rawContent.trim() || !activeTopic) return;
    setIsTransforming(true);
    setSaveSuccess(null);
    try {
      const res = await fetch('/api/notebooklm/transform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicId: activeTopic.id,
          rawContent,
          flowName: selectedFlow.name,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al procesar con el Catedrático');

      setTransformedDraft({
        title: customTitle.trim() || data.title,
        content: data.content,
        agentName: data.agentName,
        words: data.words,
        subjectName: data.subjectName,
      });
      setEditMode(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error al procesar');
    } finally {
      setIsTransforming(false);
    }
  };

  // 2. Guardar definitivamente en Cuaderno Notion
  const handleConfirmSave = async () => {
    if (!activeTopic) return;
    const contentToSave = transformedDraft?.content || rawContent;
    const titleToSave = transformedDraft?.title || customTitle || `U${activeTopic.unitNumber ?? 1} · ${activeTopic.title}`;

    if (!contentToSave.trim()) return;

    setIsSaving(true);
    try {
      const res = await fetch('/api/notebooklm/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicId: activeTopic.id,
          title: titleToSave,
          content: contentToSave,
          flowId: selectedFlow.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar');
      setSaveSuccess(data.title);
      setTransformedDraft(null);
      setRawContent('');
      setCustomTitle('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error al guardar en Notion');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-mono uppercase tracking-wider mb-1">
            <Sparkles className="w-4 h-4" />
            <span>Motor de Fuentes & Filtrado por Cátedra</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-100">
            NotebookLM Studio & Catedráticos
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Genera material con NotebookLM y deja que el{' '}
            <strong className="text-emerald-300">Catedrático IA de cada materia</strong>{' '}
            lo filtre, ordene y transforme en apuntes de cátedra con formato Notion antes de guardarlo.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <a
            href="#paso-4-maquetar"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 font-semibold text-sm transition-all"
          >
            <span>⚡ Ir a Maquetar con Catedrático (Paso 4)</span>
            <ArrowRight className="w-4 h-4" />
          </a>

          <a
            href="https://notebooklm.google.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-slate-950 font-semibold text-sm shadow-lg shadow-emerald-500/20 hover:brightness-110 transition-all"
          >
            <span>Abrir Google NotebookLM</span>
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>

      {/* Sourcing Rules Banner */}
      <div className="bg-slate-900/60 border border-emerald-500/30 rounded-2xl p-5 backdrop-blur-sm">
        <div className="flex items-start gap-4">
          <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 shrink-0">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div className="space-y-2 flex-1">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <span>Principio de Fidelidad Absoluta (Jerarquía de Fuentes en NotebookLM)</span>
              <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded font-mono">
                1 Notebook por Asignatura
              </span>
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Carga en tu Notebook de Google las fuentes con este orden riguroso para que los Catedráticos puedan citar con exactitud:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2.5 pt-1 text-xs">
              <div className="p-2.5 rounded-lg bg-slate-800/80 border border-slate-700/60">
                <span className="text-emerald-400 font-bold block mb-0.5">1º Temario Oficial</span>
                <span className="text-slate-400 text-[11px]">Currículo oficial de 1º Bachillerato.</span>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-800/80 border border-slate-700/60">
                <span className="text-sky-400 font-bold block mb-0.5">2º Apuntes & Diapositivas</span>
                <span className="text-slate-400 text-[11px]">Material de Moodle Centros de tu profesor.</span>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-800/80 border border-slate-700/60">
                <span className="text-amber-400 font-bold block mb-0.5">3º Boletines & Exámenes</span>
                <span className="text-slate-400 text-[11px]">Problemas de clase y exámenes reales.</span>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-800/80 border border-slate-700/60">
                <span className="text-purple-400 font-bold block mb-0.5">4º Libro de Texto</span>
                <span className="text-slate-400 text-[11px]">Editorial oficial para definiciones canónicas.</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Selectores de Materia y Tema */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Asignatura */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
            1. Asignatura (Cuaderno de NotebookLM)
          </label>
          <div className="flex flex-wrap gap-2">
            {subjects.map((sub) => {
              const isSelected = sub.id === selectedSubject?.id;
              return (
                <button
                  key={sub.id}
                  onClick={() => {
                    setSelectedSubjectId(sub.id);
                    setSelectedTopicId('');
                    setTransformedDraft(null);
                  }}
                  className={`px-3 py-2 rounded-xl text-xs font-medium transition-all flex items-center gap-2 ${
                    isSelected
                      ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300 border shadow-sm'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 border'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: sub.color || '#10b981' }}
                  />
                  <span>{sub.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Tema / Unidad */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
            2. Unidad Temática Activa
          </label>
          <select
            value={activeTopic?.id || ''}
            onChange={(e) => {
              setSelectedTopicId(e.target.value);
              setTransformedDraft(null);
            }}
            className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-emerald-500 transition-colors"
          >
            {selectedSubject?.topics.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.unitNumber ? `U${topic.unitNumber} · ` : ''}
                {topic.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Catálogo de los 11 Flujos */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
            3. Selecciona el Flujo de Estudio
          </label>
          <span className="text-xs text-slate-400 font-mono">
            {NOTEBOOKLM_FLOWS.length} Flujos de Cátedra
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {NOTEBOOKLM_FLOWS.map((flow) => {
            const isSelected = flow.id === selectedFlow.id;
            return (
              <button
                key={flow.id}
                onClick={() => setSelectedFlowId(flow.id)}
                className={`text-left p-3.5 rounded-xl border transition-all flex flex-col justify-between gap-2 ${
                  isSelected
                    ? 'bg-emerald-950/30 border-emerald-500 text-slate-100 shadow-md shadow-emerald-950/40 ring-1 ring-emerald-500/50'
                    : 'bg-slate-900/60 border-slate-800/80 text-slate-300 hover:border-slate-700 hover:bg-slate-900'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs font-semibold">{flow.name}</span>
                    <span
                      className={`text-[9px] uppercase px-1.5 py-0.5 rounded font-mono ${
                        flow.category === 'comprension'
                          ? 'bg-sky-500/10 text-sky-400 border border-sky-500/30'
                          : flow.category === 'practica'
                          ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                          : flow.category === 'evaluacion'
                          ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                          : 'bg-purple-500/10 text-purple-400 border border-purple-500/30'
                      }`}
                    >
                      {flow.category}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 line-clamp-2">
                    {flow.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Prompt Generado con Botón Copiar */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-400" />
              <span>Prompt Calibrado para NotebookLM: {selectedFlow.name}</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Copia este prompt y pégalo en la barra de chat de tu cuaderno en Google NotebookLM.
            </p>
          </div>

          <button
            onClick={handleCopyPrompt}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all shadow-md shrink-0 ${
              copied
                ? 'bg-emerald-600 text-white'
                : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
            }`}
          >
            {copied ? (
              <>
                <Check className="w-4 h-4" />
                <span>¡Copiado al portapapeles!</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                <span>Copiar Prompt para NotebookLM</span>
              </>
            )}
          </button>
        </div>

        <pre className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-emerald-300 font-mono whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto">
          {generatedPrompt}
        </pre>
      </div>

      {/* Ingesta, Filtrado por Cátedra y Vista Previa */}
      <div id="paso-4-maquetar" className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6 scroll-mt-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-4">
          <div>
            <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <GraduationCap className="w-5 h-5 text-emerald-400" />
              <span>Paso 4: Filtrado por el Catedrático y Transformación Notion</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Pega la respuesta de NotebookLM. El Catedrático de {selectedSubject?.name} la manipulará,
              filtrará redundancias, organizará las fórmulas y te mostrará la vista previa.
            </p>
          </div>
        </div>

        {saveSuccess && (
          <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400" />
              <span>
                ¡Apunte de Cátedra <strong>«{saveSuccess}»</strong> consolidado con éxito en tu Cuaderno Notion!
              </span>
            </div>
            <Link
              href="/apuntes"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 font-semibold transition-colors"
            >
              <span>Abrir Cuaderno Notion</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}

        {/* FASE 1: Cajón de pegar respuesta en bruto */}
        {!transformedDraft && (
          <div className="space-y-4">
            <textarea
              rows={8}
              placeholder={`Pega aquí la respuesta en bruto obtenida de Google NotebookLM para ${activeTopic?.title || 'este tema'}...`}
              value={rawContent}
              onChange={(e) => setRawContent(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl p-4 focus:outline-none focus:border-emerald-500 font-mono leading-relaxed"
            />

            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
              <span className="text-[11px] text-slate-500 font-mono">
                {rawContent ? `${rawContent.length} caracteres introducidos` : 'Esperando datos de NotebookLM'}
              </span>

              <button
                onClick={handleTransformWithCatedratico}
                disabled={isTransforming || !rawContent.trim()}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 disabled:opacity-50 text-slate-950 font-bold text-xs shadow-lg shadow-emerald-500/20 transition-all"
              >
                {isTransforming ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>El Catedrático está procesando y maquetando...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>Filtrar y Maquetar con Catedrático de {selectedSubject?.name}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* FASE 2: Vista previa interactiva de Cátedra (Manipulación completada) */}
        {transformedDraft && (
          <div className="space-y-5 animate-in fade-in duration-300">
            {/* Barra superior de control de la vista previa */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl bg-slate-950 border border-emerald-500/40">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs font-semibold text-emerald-300">
                  Vista Previa de Cátedra ({transformedDraft.agentName})
                </span>
                <span className="text-[11px] text-slate-400 font-mono">
                  · {transformedDraft.words} palabras
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditMode(!editMode)}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 text-xs font-medium hover:text-white flex items-center gap-1.5 transition-colors"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>{editMode ? 'Ver Maquetado' : 'Editar Markdown'}</span>
                </button>

                <button
                  onClick={() => setTransformedDraft(null)}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-slate-400 text-xs font-medium hover:text-rose-400 flex items-center gap-1.5 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Descartar</span>
                </button>
              </div>
            </div>

            {/* Editor de Título */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Título del Apunte para Notion:
              </label>
              <input
                type="text"
                value={transformedDraft.title}
                onChange={(e) =>
                  setTransformedDraft({ ...transformedDraft, title: e.target.value })
                }
                className="w-full bg-slate-950 border border-slate-800 text-slate-100 text-sm font-bold rounded-xl px-4 py-2.5 focus:outline-none focus:border-emerald-500"
              />
            </div>

            {/* Vista renderizada tipo Notion vs Editor Markdown */}
            {editMode ? (
              <textarea
                rows={16}
                value={transformedDraft.content}
                onChange={(e) =>
                  setTransformedDraft({ ...transformedDraft, content: e.target.value })
                }
                className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl p-4 font-mono leading-relaxed focus:outline-none focus:border-emerald-500"
              />
            ) : (
              <div className="p-6 rounded-2xl bg-slate-950/90 border border-slate-800 max-h-[580px] overflow-y-auto shadow-inner">
                <NoteRenderer
                  content={transformedDraft.content}
                />
              </div>
            )}

            {/* Botón de Aprobación Final */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-slate-800">
              <div className="text-xs text-slate-400">
                ¿Te convence la estructura del apunte? Pulsa aprobar para consolidarlo en tu Cuaderno.
              </div>

              <button
                onClick={handleConfirmSave}
                disabled={isSaving}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs shadow-lg shadow-emerald-500/20 transition-all"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Consolidando en Notion...</span>
                  </>
                ) : (
                  <>
                    <BookmarkPlus className="w-4 h-4" />
                    <span>Aprobar y Guardar en mi Cuaderno Notion</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
