'use client';

import { useState, useTransition } from 'react';
import { Plus, X, GraduationCap } from 'lucide-react';
import { createExam } from '@/lib/actions';

interface CreateExamModalProps {
  subjects: Array<{ id: string; name: string }>;
  /**
   * El lanzador ya ha recibido el clic: este componente se carga para estar
   * abierto, no para enseñar otro botón que habría que volver a pulsar.
   */
  initialOpen?: boolean;
}

export default function CreateExamModal({ subjects, initialOpen = false }: CreateExamModalProps) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [isPending, startTransition] = useTransition();

  const [formData, setFormData] = useState({
    subjectId: subjects[0]?.id || '',
    title: '',
    examDate: '',
    weightPercent: 30,
    examType: 'parcial',
    examFormat: 'test',
    targetGrade: 9.0,
    notes: '',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title || !formData.examDate) return;

    startTransition(async () => {
      await createExam({
        subjectId: formData.subjectId,
        title: formData.title,
        examDate: formData.examDate,
        weightPercent: Number(formData.weightPercent),
        examType: formData.examType,
        examFormat: formData.examFormat,
        targetGrade: Number(formData.targetGrade),
        notes: formData.notes,
      });
      setIsOpen(false);
      setFormData({
        subjectId: subjects[0]?.id || '',
        title: '',
        examDate: '',
        weightPercent: 30,
        examType: 'parcial',
        examFormat: 'test',
        targetGrade: 9.0,
        notes: '',
      });
    });
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:scale-105"
      >
        <Plus className="w-4 h-4 stroke-[3]" />
        <span>Añadir Examen o Simulacro</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-card rounded-2xl w-full max-w-lg p-6 shadow-2xl relative">
            <button
              onClick={() => setIsOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-100"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400">
                <GraduationCap className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">
                  Nuevo Hito de Examen
                </h3>
                <p className="text-xs text-slate-400">
                  Registra un examen de evaluación, final o simulacro PAU.
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
                    value={formData.subjectId}
                    onChange={(e) =>
                      setFormData({ ...formData, subjectId: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
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
                    Tipo de Prueba
                  </label>
                  <select
                    value={formData.examType}
                    onChange={(e) =>
                      setFormData({ ...formData, examType: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="parcial">Parcial Evaluación</option>
                    <option value="final">Final de Trimestre</option>
                    <option value="simulacro_pau">Simulacro PAU / Selectividad</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Formato de la prueba
                  </label>
                  <select
                    value={formData.examFormat}
                    onChange={(e) =>
                      setFormData({ ...formData, examFormat: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="test">Test (preguntas cortas)</option>
                    <option value="desarrollo">Desarrollo (temas y redacción)</option>
                    <option value="practico">Práctico (problemas y ejercicios)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Título del Examen / Temario
                </label>
                <input
                  type="text"
                  placeholder="p.ej. Parcial 2ª Ev: Geometría R3 y Límites"
                  value={formData.title}
                  onChange={(e) =>
                    setFormData({ ...formData, title: e.target.value })
                  }
                  required
                  className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Fecha
                  </label>
                  <input
                    type="date"
                    value={formData.examDate}
                    onChange={(e) =>
                      setFormData({ ...formData, examDate: e.target.value })
                    }
                    required
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Peso (%)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={formData.weightPercent}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        weightPercent: Number(e.target.value),
                      })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Nota Objetivo
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="1"
                    max="10"
                    value={formData.targetGrade}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        targetGrade: Number(e.target.value),
                      })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Notas de Enfoque y Criterios
                </label>
                <textarea
                  rows={2}
                  placeholder="Detalles sobre qué temas entran, si descuentan faltas de ortografía, etc."
                  value={formData.notes}
                  onChange={(e) =>
                    setFormData({ ...formData, notes: e.target.value })
                  }
                  className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                />
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
                  className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-all shadow-md"
                >
                  {isPending ? 'Guardando...' : 'Crear Examen'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
