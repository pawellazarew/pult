import { translator } from '../../../src/i18n/core.js'
import { componentsEn } from '../locales/components.en.js'
import { modelsEn } from '../locales/models.en.js'
export { getLanguage } from '../../../src/i18n/core.js'
export const t = translator({ ...componentsEn, ...modelsEn })
