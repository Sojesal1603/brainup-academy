'use client';

import { useState, useTransition } from 'react';
import { Plus, X, AlertOctagon } from 'lucide-react';
import { createErrorLog } from '@/lib/actions';
import { ERROR_CAUSES, ErrorRootCause } from '@/lib/types';

interface CreateErrorModalProps {
  subjects: Array<{
    id: string;
    name: string;
    topics: Array<{ id: string; title: string }>;
  }>;
}

export default function CreateErrorModal({ subjects }: CreateErrorModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const [selectedSubjectId, setSelectedSubjectId] = useState(
    subjects[0]?.id || ''
  );
  const currentSubject = subjects.find((s) => s.id === selectedSubjectId);

  const [formData, setFormData] = useState({
    topicId: currentSubject?.topics[0]?.id || '',
    questionPrompt: '',
    myAnswer: '',
    correctAnswer: '',
    rootCause: 'concepto' as ErrorRootCause,
    keyLesson: '',
    correctiveAction: '',
  });

  const handleSubjectChange = (subjectId: string) => {
    setSelectedSubjectId(subjectId);
    const sub = subjects.find((s) => s.id === subjectId);
    setFormData((prev) => ({
      ...prev,
      topicId: sub?.topics[0]?.id || '',
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !formData.topicId ||
      !formData.questionPrompt ||
      !formData.myAnswer ||
      !formData.correctAnswer
    )
      return;

    startTransition(async () => {
      await createErrorLog({
        subjectId: selectedSubjectId,
        topicId: formData.topicId,
        questionPrompt: formData.questionPrompt,
        myAnswer: formData.myAnswer,
        correctAnswer: formData.correctAnswer,
        rootCause: formData.rootCause,
        keyLesson: formData.keyLesson,
        correctiveAction: formData.correctiveAction,
      });

      setIsOpen(false);
      setFormData({
        topicId: currentSubject?.topics[0]?.id || '',
        questionPrompt: '',
        myAnswer: '',
        correctAnswer: '',
        rootCause: 'concepto',
        keyLesson: '',
        correctiveAction: '',
      });
    });
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 text-slate-950 font-bold text-xs transition-all shadow-[0_0_15px_rgba(244,63,94,0.3)] hover:scale-105"
      >
        <Plus className="w-4 h-4 stroke-[3]" />
        <span>Registrar Error Quirúrgico</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#0e1424] border border-white/10 rounded-2xl w-full max-w-2xl p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <button
              onClick={() => setIsOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-100"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400">
                <AlertOctagon className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">
                  Autopsia de Error Académico
                </h3>
                <p className="text-xs text-slate-400">
                  Cada fallo registrado aumenta la prioridad del tema en el planificador.
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Asignatura
                  </label>
                  <select
                    value={selectedSubjectId}
                    onChange={(e) => handleSubjectChange(e.target.value)}
                    className="w-full bg-[#080d18] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                  >
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Tema Específico
                  </label>
                  <select
                    value={formData.topicId}
                    onChange={(e) =>
                      setFormData({ ...formData, topicId: e.target.value })
                    }
                    className="w-full bg-[#080d18] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                  >
                    {currentSubject?.topics.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Causa Raíz */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Causa Raíz del Error
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {Object.entries(ERROR_CAUSES).map(([key, val]) => (
                    <button
                      type="button"
                      key={key}
                      onClick={() =>
                        setFormData({
                          ...formData,
                          rootCause: key as ErrorRootCause,
                        })
                      }
                      className={`px-3 py-2 rounded-lg border text-xs text-left transition-all ${
                        formData.rootCause === key
                          ? `${val.badgeColor} border-current font-bold bg-opacity-20`
                          : 'bg-[#080d18] border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <p className="font-semibold">{val.label}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Pregunta / Enunciado */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Enunciado o Pregunta Fallada
                </label>
                <textarea
                  rows={2}
                  placeholder="Enunciado exacto del problema o pregunta teórica de examen..."
                  value={formData.questionPrompt}
                  onChange={(e) =>
                    setFormData({ ...formData, questionPrompt: e.target.value })
                  }
                  required
                  className="w-full bg-[#080d18] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                />
              </div>

              {/* Comparativa: Lo que puse vs Solución Oficial */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-rose-400 mb-1">
                    Mi Respuesta (Errónea)
                  </label>
                  <textarea
                    rows={3}
                    placeholder="Lo que respondí o el camino que intenté tomar..."
                    value={formData.myAnswer}
                    onChange={(e) =>
                      setFormData({ ...formData, myAnswer: e.target.value })
                    }
                    required
                    className="w-full bg-[#130b14] border border-rose-900/60 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-emerald-400 mb-1">
                    Respuesta Correcta Oficial
                  </label>
                  <textarea
                    rows={3}
                    placeholder="El planteamiento y resultado oficial exigido en la PAU..."
                    value={formData.correctAnswer}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        correctAnswer: e.target.value,
                      })
                    }
                    required
                    className="w-full bg-[#091515] border border-emerald-900/60 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              {/* Lección y Acción Preventiva */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Lección Clave (El Principio)
                  </label>
                  <input
                    type="text"
                    placeholder="p.ej. El vector normal de un plano es perpendicular a él, no paralelo."
                    value={formData.keyLesson}
                    onChange={(e) =>
                      setFormData({ ...formData, keyLesson: e.target.value })
                    }
                    required
                    className="w-full bg-[#080d18] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Acción Preventiva (Mi Regla Futura)
                  </label>
                  <input
                    type="text"
                    placeholder="p.ej. Siempre dibujar un croquis del vector normal saliendo de la hoja."
                    value={formData.correctiveAction}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        correctiveAction: e.target.value,
                      })
                    }
                    required
                    className="w-full bg-[#080d18] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="px-4 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 rounded-lg bg-rose-500 hover:bg-rose-400 text-slate-950 font-bold text-xs transition-all shadow-md"
                >
                  {isPending ? 'Procesando...' : 'Guardar en el Banco'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
