// El arnés del BUZÓN (capa mail, 12e-b): los helpers con los que un flujo afirma sobre el correo que salió. Los mismos que
// el AbstractFlowIT de keel-spring, el flow.ts de keel-nest y el Mail.cs de keel-dotnet (AwaitMailTo, LastMailTo,
// MailCount, AssertNoMailTo, RelayRejectsRecipients, RelayAccepts, RejectedAddress y el asunto, los cuerpos y el remitente
// de un mensaje), con el vocabulario de keel-core (`gen/mail-probes.js`): las rutas, los campos, la repaginación y el
// rechazo hablan con el mismo Mailpit, y salen del mismo módulo que el sondeo de validate-infra.sh y la purga de
// reset-db.sh.
//
// `tests/integration/mail_test.go` no usa nada del resto del arnés salvo el Scenario —net/http y encoding/json—, así que
// `mail-check` lo ejecuta contra un Mailpit real.

import { HOST_BASE, HTTP_PORT, ROUTES, SEARCH_PREFIX, SEARCH_LIMIT, SEARCH_LIMIT_PARAM, searchSuffix, CHAOS_REJECT_RECIPIENTS, CHAOS_OFF, REJECTED_DOMAIN, MAIL_AWAIT, mailAwaitSeconds } from '@keel-system/keel-core/gen/mail-probes';
import { goString } from '../lib/go-source.js';
import { usesGoMail } from './mail.js';

export const MAIL_HARNESS_FILE = 'mail_test.go';
export const MAIL_HARNESS_IMPORTS = ['encoding/json', 'fmt', 'io', 'net/http', 'net/url', 'os', 'strings', 'time'];

/** SMOKE-7, el de los otros tres: el buzón responde y el reset lo deja vacío. */
export function mailSmokeCase(model) {
  if (!usesGoMail(model)) return null;
  return String.raw`	f.Scenario("SMOKE-7: el buzón de prueba responde y el reset lo deja vacío", func(s *Scenario) {
		// Un correo de la corrida anterior haría que el primer AwaitMailTo de un flujo devolviera el mensaje equivocado.
		if got := s.MailCount("humo@keel.test"); got != 0 {
			s.Errorf("el buzón tiene %d correos para humo@keel.test tras el reset", got)
		}
	})`;
}

/** El cuerpo de tests/integration/mail_test.go, o null sin capa mail. */
export function mailHarnessBody(model) {
  if (!usesGoMail(model)) return null;
  const wait = mailAwaitSeconds(model);
  const waitDoc =
    wait.period == null
      ? '// El correo sale dentro de la operación que atiende la petición: no hay barrido de por medio, y lo único que cubre esta\n// espera es el viaje al relay.'
      : `// Sale del contrato, no de un número redondo: el correo lo empuja un barrido con cadencia de ${wait.period} s (el schedule más\n// rápido del diseño) más un margen de ${MAIL_AWAIT.marginSeconds} s, con techo de ${MAIL_AWAIT.capSeconds} s.`;
  return String.raw`
// mailAwait es el techo de cualquier espera de correo.
${waitDoc}
const mailAwait = ${wait.seconds} * time.Second

// mailSearchLimit es el techo de una búsqueda en el buzón, y el punto donde se repagina (ver mailIDsTo).
const mailSearchLimit = ${SEARCH_LIMIT}

// mailHTTP es el cliente del buzón de prueba.
var mailHTTP = &http.Client{Timeout: 30 * time.Second}

// mailAPI es la API del buzón (o MAIL_API del entorno).
func mailAPI() string {
	if configured := os.Getenv("MAIL_API"); configured != "" {
		return configured
	}
	return ${goString(HOST_BASE)}
}

// MailboxMessage es un correo leído del buzón, entero.
type MailboxMessage map[string]any

// Subject es su asunto.
func (m MailboxMessage) Subject() string { return m.text("Subject") }

// HTML es su cuerpo HTML.
func (m MailboxMessage) HTML() string { return m.text("HTML") }

// Text es su cuerpo en texto.
func (m MailboxMessage) Text() string { return m.text("Text") }

// From es la dirección de su remitente, o "".
func (m MailboxMessage) From() string {
	from, _ := m["From"].(map[string]any)
	address, _ := from["Address"].(string)
	return address
}

func (m MailboxMessage) text(field string) string {
	value, _ := m[field].(string)
	return value
}

// AwaitMailTo espera a que haya count correos para address y devuelve sus ids, más reciente primero.
func (s *Scenario) AwaitMailTo(address string, count int) []string {
	s.Helper()
	var ids []string
	for deadline := time.Now().Add(mailAwait); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		ids = s.mailIDsTo(address)
		if len(ids) >= count {
			return ids
		}
	}
	s.Fatalf("se esperaban %d correo(s) para %s y llegaron %d en %s. El buzón se mira en http://localhost:${HTTP_PORT}", count, address, len(ids), mailAwait)
	return nil
}

// LastMailTo es el correo más reciente para address, entero (espera a que llegue).
func (s *Scenario) LastMailTo(address string) MailboxMessage {
	s.Helper()
	ids := s.AwaitMailTo(address, 1)
	var message MailboxMessage
	s.mailGet(${goString(ROUTES.message(''))}+ids[0], &message)
	return message
}

// MailCount es cuántos correos hay para address, sin esperar.
func (s *Scenario) MailCount(address string) int {
	s.Helper()
	return len(s.mailIDsTo(address))
}

// AssertNoMailTo espera el techo entero y falla si salió algún correo para address.
func (s *Scenario) AssertNoMailTo(address string) {
	s.Helper()
	time.Sleep(mailAwait)
	if count := s.MailCount(address); count > 0 {
		s.Fatalf("no debía salir ningún correo para %s y salieron %d", address, count)
	}
}

// RelayRejectsRecipients hace que el relay rechace a los destinatarios (el caos de Mailpit): el envío fallido.
func (s *Scenario) RelayRejectsRecipients() {
	s.Helper()
	s.mailPut(${goString(ROUTES.chaos())}, ${goString(CHAOS_REJECT_RECIPIENTS)})
}

// RelayAccepts deja de rechazar.
func (s *Scenario) RelayAccepts() {
	s.Helper()
	s.mailPut(${goString(ROUTES.chaos())}, ${goString(CHAOS_OFF)})
}

// RejectedAddress es una dirección que el relay de prueba rechaza SIEMPRE (el envío parcial): localPart@${REJECTED_DOMAIN}.
func RejectedAddress(localPart string) string {
	return localPart + "@" + ${goString(REJECTED_DOMAIN)}
}

// mailIDsTo son los ids de los correos para address, más reciente primero. La respuesta trae dos números: la lista,
// RECORTADA por limit, y el conteo de los que casan, que no se recorta. Leer solo la lista pone un techo a MailCount: por
// eso se mira el total y, si supera el techo, se repite la búsqueda pidiendo exactamente ese total.
func (s *Scenario) mailIDsTo(address string) []string {
	s.Helper()
	query := url.QueryEscape("to:" + address)
	var found struct {
		Messages []struct {
			ID string
		} ${'`json:"messages"`'}
		Count int ${'`json:"messages_count"`'}
	}
	s.mailGet(${goString(SEARCH_PREFIX)}+query+${goString(searchSuffix())}, &found)
	if found.Count > mailSearchLimit {
		s.mailGet(${goString(SEARCH_PREFIX)}+query+${goString(SEARCH_LIMIT_PARAM)}+fmt.Sprint(found.Count), &found)
	}
	ids := make([]string, 0, len(found.Messages))
	for _, message := range found.Messages {
		ids = append(ids, message.ID)
	}
	return ids
}

func (s *Scenario) mailGet(path string, out any) {
	s.Helper()
	response, err := mailHTTP.Get(mailAPI() + path)
	if err != nil {
		s.Fatalf("no se pudo hablar con el buzón de prueba en %s. ¿Está levantado el compose de infra/? (bash infra/validate-infra.sh): %v", mailAPI(), err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode >= 300 {
		s.Fatalf("el buzón de prueba rechazó %s (HTTP %d): %s", path, response.StatusCode, body)
	}
	if err := json.Unmarshal(body, out); err != nil {
		s.Fatalf("el buzón de prueba devolvió algo que no es JSON en %s: %v", path, err)
	}
}

func (s *Scenario) mailPut(path, body string) {
	s.Helper()
	request, err := http.NewRequestWithContext(s.Context(), http.MethodPut, mailAPI()+path, strings.NewReader(body))
	if err != nil {
		s.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := mailHTTP.Do(request)
	if err != nil {
		s.Fatalf("no se pudo hablar con el buzón de prueba en %s: %v", mailAPI(), err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		// El cuerpo solo ilustra el fallo: si no se puede leer, el status ya lo dice.
		text, _ := io.ReadAll(response.Body)
		s.Fatalf("el buzón de prueba rechazó %s (HTTP %d): %s. ¿Arrancó con MP_ENABLE_CHAOS? (infra/docker-compose.yaml)", path, response.StatusCode, text)
	}
}
`;
}
