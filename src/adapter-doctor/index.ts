export { createAdapterDoctor } from './doctor.ts';
export { HttpAdapterDoctorTarget, type AdapterDoctorTarget } from './http-target.ts';
export {
  ADAPTER_DOCTOR_SCOPE,
  adapterDoctorReportSchema,
  type AdapterDoctorCheck,
  type AdapterDoctorReport,
} from './report.ts';
export {
  targetFeatureSchema,
  targetDescriptionSchema,
  type TargetFeature,
  type TargetDescription,
} from '#integrations/target-contract';
