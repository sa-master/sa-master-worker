const STATUS_LABELS = {
  new: "Нова",
  processing: "Опрацювання",
  estimate: "Прорахунок",
  approved: "Погоджено",
  scheduled: "Заплановано",
  installation: "Монтаж",
  completed: "Завершено",
  service: "Сервіс",
  cancelled: "Відмова / Неактуально"
};

export default {
  async fetch(request, env) {

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {

      // =========================================================
      // GET /
      // Перевірка Worker та bindings
      // =========================================================

      if (request.method === "GET" && path === "/") {

        return json({
          ok: true,

          BOT_TOKEN: !!env.BOT_TOKEN,
          CHAT_ID: !!env.CHAT_ID,
          DB: !!env.DB,
          FILES: !!env.FILES,

          bindings: Object.keys(env),

          statuses: STATUS_LABELS
        }, cors);
      }


      // =========================================================
      // GET /r2-test
      // Тимчасовий тест R2
      // =========================================================

      if (
        request.method === "GET" &&
        path === "/r2-test"
      ) {

        if (!env.FILES) {
          return json({
            ok: false,
            error: "R2 binding FILES не підключений"
          }, cors, 500);
        }

        const testKey =
          "system-tests/r2-test.txt";

        const testText =
          `SA-MASTER R2 TEST ${new Date().toISOString()}`;

        await env.FILES.put(
          testKey,
          testText,
          {
            httpMetadata: {
              contentType:
                "text/plain; charset=utf-8"
            }
          }
        );

        const storedObject =
          await env.FILES.get(testKey);

        if (!storedObject) {
          return json({
            ok: false,
            error:
              "Файл записаний, але прочитати його не вдалося",
            key: testKey
          }, cors, 500);
        }

        const readText =
          await storedObject.text();

        return json({
          ok: true,
          message: "R2 працює",
          bucket: "sa-master-files",
          key: testKey,
          written: testText,
          read: readText,
          size: storedObject.size,
          uploaded:
            storedObject.uploaded || null
        }, cors);
      }


      // =========================================================
      // GET /requests
      // =========================================================

      if (
        request.method === "GET" &&
        path === "/requests"
      ) {

        const result =
          await env.DB.prepare(`
            SELECT
              r.*,
              c.id AS client_id,
              c.name AS client_name,
              c.phone AS client_phone
            FROM requests r
            LEFT JOIN clients c
              ON c.id = r.client_id
            ORDER BY r.id DESC
          `).all();

        const requests =
          (result.results || []).map(r => ({
            ...r,
            status_label:
              STATUS_LABELS[r.status] ||
              r.status ||
              "Невідомо"
          }));

        return json({
          ok: true,
          requests
        }, cors);
      }


      // =========================================================
      // POST /request/:requestCode/client
      // Створення / пошук клієнта для заявки
      // =========================================================

      if (
        request.method === "POST" &&
        path.startsWith("/request/") &&
        path.endsWith("/client")
      ) {

        const requestCode =
          decodeURIComponent(
            path
              .replace("/request/", "")
              .replace("/client", "")
              .replace(/\/+$/, "")
          );

        const requestResult =
          await env.DB.prepare(`
            SELECT *
            FROM requests
            WHERE request_code = ?
            LIMIT 1
          `).bind(requestCode).all();

        if (
          !requestResult.results ||
          !requestResult.results.length
        ) {
          return json({
            ok: false,
            error: "Заявку не знайдено"
          }, cors, 404);
        }

        const req =
          requestResult.results[0];

        if (req.client_id) {

          const clientResult =
            await env.DB.prepare(`
              SELECT *
              FROM clients
              WHERE id = ?
              LIMIT 1
            `).bind(req.client_id).all();

          return json({
            ok: true,
            created: false,
            existing: true,
            request: req,
            client:
              clientResult.results?.[0] || null
          }, cors);
        }

        const normalizedPhone =
          normalizePhone(req.phone);

        const clientResult =
          await env.DB.prepare(`
            SELECT *
            FROM clients
            WHERE phone = ?
            LIMIT 1
          `).bind(normalizedPhone).all();

        let client;
        let created = false;
        let existing = false;

        if (
          clientResult.results &&
          clientResult.results.length
        ) {

          client =
            clientResult.results[0];

          existing = true;

        } else {

          const insertClient =
            await env.DB.prepare(`
              INSERT INTO clients (
                name,
                phone
              )
              VALUES (?, ?)
            `).bind(
              req.name,
              normalizedPhone
            ).run();

          if (!insertClient.meta?.last_row_id) {
            return json({
              ok: false,
              error: "Не вдалося створити клієнта"
            }, cors, 500);
          }

          const newClientResult =
            await env.DB.prepare(`
              SELECT *
              FROM clients
              WHERE id = ?
              LIMIT 1
            `).bind(
              insertClient.meta.last_row_id
            ).all();

          client =
            newClientResult.results?.[0] || null;

          created = true;
        }

        await env.DB.prepare(`
          UPDATE requests
          SET client_id = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          client.id,
          req.id
        ).run();

        return json({
          ok: true,
          created,
          existing,

          request: {
            ...req,
            client_id: client.id
          },

          client
        }, cors);
      }


      // =========================================================
      // POST /request/:requestCode/status
      // Зміна статусу заявки
      // + історія
      // + синхронізація статусу об'єкта
      // =========================================================

      if (
        request.method === "POST" &&
        path.startsWith("/request/") &&
        path.endsWith("/status")
      ) {

        const requestCode =
          decodeURIComponent(
            path
              .replace("/request/", "")
              .replace("/status", "")
              .replace(/\/+$/, "")
          );

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            ok: false,
            error: "Некоректний JSON"
          }, cors, 400);
        }

        const newStatus =
          String(body.status || "").trim();

        if (!STATUS_LABELS[newStatus]) {
          return json({
            ok: false,
            error: "Невідомий статус",
            allowed_statuses: STATUS_LABELS
          }, cors, 400);
        }

        const requestResult =
          await env.DB.prepare(`
            SELECT
              id,
              request_code,
              status,
              object_id
            FROM requests
            WHERE request_code = ?
            LIMIT 1
          `).bind(requestCode).all();

        if (
          !requestResult.results ||
          !requestResult.results.length
        ) {
          return json({
            ok: false,
            error: "Заявку не знайдено"
          }, cors, 404);
        }

        const currentRequest =
          requestResult.results[0];

        const oldStatus =
          currentRequest.status;

        const updateResult =
          await env.DB.prepare(`
            UPDATE requests
            SET status = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            newStatus,
            currentRequest.id
          ).run();

        if (
          updateResult.meta &&
          updateResult.meta.changes !== 1
        ) {
          return json({
            ok: false,
            error: "Статус заявки не було змінено"
          }, cors, 500);
        }

        const oldStatusLabel =
          STATUS_LABELS[oldStatus] ||
          oldStatus ||
          "Невідомо";

        const newStatusLabel =
          STATUS_LABELS[newStatus];

        const eventContent =
          `${oldStatusLabel} → ${newStatusLabel}`;


        // -------------------------------------------------------
        // Історія заявки
        // -------------------------------------------------------

        const eventResult =
          await env.DB.prepare(`
            INSERT INTO events (
              object_id,
              request_id,
              event_type,
              content,
              author_type
            )
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            currentRequest.object_id || null,
            currentRequest.id,
            "status_changed",
            eventContent,
            "system"
          ).run();

        if (
          eventResult.meta &&
          eventResult.meta.changes !== 1
        ) {
          return json({
            ok: false,
            error:
              "Статус змінено, але подію не вдалося записати"
          }, cors, 500);
        }


        // -------------------------------------------------------
        // Синхронізація статусу об'єкта
        // -------------------------------------------------------

        let objectUpdated = false;
        let object = null;

        if (
          currentRequest.object_id &&
          newStatus !== "cancelled"
        ) {

          const objectUpdate =
            await env.DB.prepare(`
              UPDATE objects
              SET status = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(
              newStatus,
              currentRequest.object_id
            ).run();

          objectUpdated =
            !objectUpdate.meta ||
            objectUpdate.meta.changes >= 1;

          if (objectUpdated) {

            await env.DB.prepare(`
              INSERT INTO events (
                object_id,
                request_id,
                event_type,
                content,
                author_type
              )
              VALUES (?, ?, ?, ?, ?)
            `).bind(
              currentRequest.object_id,
              currentRequest.id,
              "object_status_changed",
              `Статус об'єкта → ${newStatusLabel}`,
              "system"
            ).run();
          }
        }


        // -------------------------------------------------------
        // Повертаємо результат
        // -------------------------------------------------------

        if (currentRequest.object_id) {

          const objectResult =
            await env.DB.prepare(`
              SELECT
                id,
                object_code,
                name,
                status
              FROM objects
              WHERE id = ?
              LIMIT 1
            `).bind(
              currentRequest.object_id
            ).all();

          object =
            objectResult.results?.[0] || null;

          if (object) {
            object.status_label =
              STATUS_LABELS[object.status] ||
              object.status ||
              "Невідомо";
          }
        }

        return json({
          ok: true,

          request: {
            id:
              currentRequest.id,

            request_code:
              currentRequest.request_code,

            old_status:
              oldStatus,

            old_status_label:
              oldStatusLabel,

            status:
              newStatus,

            status_label:
              newStatusLabel
          },

          object: object
            ? {
                ...object,
                updated: objectUpdated
              }
            : null,

          event: {
            event_type: "status_changed",
            content: eventContent,
            author_type: "system"
          }
        }, cors);
      }


      // =========================================================
      // GET /request/:requestCode/events
      // =========================================================

      if (
        request.method === "GET" &&
        path.startsWith("/request/") &&
        path.endsWith("/events")
      ) {

        const requestCode =
          decodeURIComponent(
            path
              .replace("/request/", "")
              .replace("/events", "")
              .replace(/\/+$/, "")
          );

        const requestResult =
          await env.DB.prepare(`
            SELECT
              id,
              request_code,
              status
            FROM requests
            WHERE request_code = ?
            LIMIT 1
          `).bind(requestCode).all();

        if (
          !requestResult.results ||
          !requestResult.results.length
        ) {
          return json({
            ok: false,
            error: "Заявку не знайдено"
          }, cors, 404);
        }

        const currentRequest =
          requestResult.results[0];

        const eventsResult =
          await env.DB.prepare(`
            SELECT
              id,
              request_id,
              object_id,
              event_type,
              content,
              author_type,
              author_id,
              created_at
            FROM events
            WHERE request_id = ?
            ORDER BY id ASC
          `).bind(currentRequest.id).all();

        return json({
          ok: true,

          request: {
            id:
              currentRequest.id,

            request_code:
              currentRequest.request_code,

            status:
              currentRequest.status,

            status_label:
              STATUS_LABELS[currentRequest.status] ||
              currentRequest.status ||
              "Невідомо"
          },

          events:
            eventsResult.results || []
        }, cors);
      }


      // =========================================================
      // GET /request/:requestCode
      // =========================================================

      if (
        request.method === "GET" &&
        path.startsWith("/request/")
      ) {

        const requestCode =
          decodeURIComponent(
            path
              .replace("/request/", "")
              .replace(/\/+$/, "")
          );

        const result =
          await env.DB.prepare(`
            SELECT
              r.*,
              c.name AS client_name,
              c.phone AS client_phone,
              o.object_code,
              o.name AS object_name,
              o.address AS object_address,
              o.status AS object_status
            FROM requests r
            LEFT JOIN clients c
              ON c.id = r.client_id
            LEFT JOIN objects o
              ON o.id = r.object_id
            WHERE r.request_code = ?
            LIMIT 1
          `).bind(requestCode).all();

        if (
          !result.results ||
          !result.results.length
        ) {
          return json({
            ok: false,
            error: "Заявку не знайдено"
          }, cors, 404);
        }

        const requestData =
          result.results[0];

        return json({
          ok: true,

          request: {
            ...requestData,

            status_label:
              STATUS_LABELS[requestData.status] ||
              requestData.status ||
              "Невідомо",

            object_status_label:
              STATUS_LABELS[requestData.object_status] ||
              requestData.object_status ||
              null
          }
        }, cors);
      }


      // =========================================================
      // POST /object/:objectCode/file
      // Завантаження файлу в R2 + запис у D1
      // =========================================================

      if (
        request.method === "POST" &&
        path.startsWith("/object/") &&
        path.endsWith("/file")
      ) {

        if (!env.FILES) {
          return json({
            ok: false,
            error:
              "R2 binding FILES не підключений"
          }, cors, 500);
        }

        const objectCode =
          decodeURIComponent(
            path
              .replace("/object/", "")
              .replace("/file", "")
              .replace(/\/+$/, "")
          );

        const objectResult =
          await env.DB.prepare(`
            SELECT
              id,
              object_code,
              name
            FROM objects
            WHERE object_code = ?
            LIMIT 1
          `).bind(objectCode).all();

        if (
          !objectResult.results ||
          !objectResult.results.length
        ) {
          return json({
            ok: false,
            error: "Об'єкт не знайдено"
          }, cors, 404);
        }

        const object =
          objectResult.results[0];

        let formData;

        try {
          formData =
            await request.formData();
        } catch {
          return json({
            ok: false,
            error:
              "Очікується multipart/form-data"
          }, cors, 400);
        }

        const file =
          formData.get("file");

        if (
          !file ||
          typeof file === "string" ||
          typeof file.arrayBuffer !== "function"
        ) {
          return json({
            ok: false,
            error:
              "Файл не переданий. Використай поле file."
          }, cors, 400);
        }

        const folderValue =
          String(
            formData.get("folder") ||
            "documents"
          ).trim();

        const uploadedBy =
          String(
            formData.get("uploaded_by") ||
            "system"
          ).trim();

        const originalName =
          String(
            file.name ||
            "file"
          ).trim();

        const safeName =
          originalName
            .replace(/[^\p{L}\p{N}._-]+/gu, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 180) ||
          "file";

        const timestamp =
          Date.now();

        const storageKey =
          `objects/${object.object_code}/${folderValue}/${timestamp}-${safeName}`;

        const arrayBuffer =
          await file.arrayBuffer();

        await env.FILES.put(
          storageKey,
          arrayBuffer,
          {
            httpMetadata: {
              contentType:
                file.type ||
                "application/octet-stream"
            }
          }
        );

        const versionResult =
          await env.DB.prepare(`
            SELECT
              COALESCE(MAX(version), 0) + 1 AS next_version
            FROM files
            WHERE object_id = ?
              AND name = ?
          `).bind(
            object.id,
            originalName
          ).all();

        const version =
          Number(
            versionResult.results?.[0]?.next_version ||
            1
          );

        const insertResult =
          await env.DB.prepare(`
            INSERT INTO files (
              object_id,
              name,
              file_type,
              storage_key,
              version,
              uploaded_by
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            object.id,
            originalName,
            file.type ||
              "application/octet-stream",
            storageKey,
            version,
            uploadedBy
          ).run();

        if (!insertResult.meta?.last_row_id) {

          try {
            await env.FILES.delete(
              storageKey
            );
          } catch (cleanupError) {
            console.error(
              "R2 cleanup error:",
              cleanupError
            );
          }

          return json({
            ok: false,
            error:
              "Файл записаний у R2, але метадані не вдалося записати в D1"
          }, cors, 500);
        }

        await env.DB.prepare(`
          INSERT INTO events (
            object_id,
            request_id,
            event_type,
            content,
            author_type
          )
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          object.id,
          null,
          "file_uploaded",
          `Додано файл: ${originalName}`,
          "system"
        ).run();

        return json({
          ok: true,

          file: {
            id:
              insertResult.meta.last_row_id,

            object_id:
              object.id,

            object_code:
              object.object_code,

            name:
              originalName,

            file_type:
              file.type ||
              "application/octet-stream",

            storage_key:
              storageKey,

            version,

            uploaded_by:
              uploadedBy,

            size:
              file.size || arrayBuffer.byteLength
          }
        }, cors);
      }


      // =========================================================
      // GET /object/:objectCode/files
      // Список файлів об'єкта з D1
      // =========================================================

      if (
        request.method === "GET" &&
        path.startsWith("/object/") &&
        path.endsWith("/files")
      ) {

        const objectCode =
          decodeURIComponent(
            path
              .replace("/object/", "")
              .replace("/files", "")
              .replace(/\/+$/, "")
          );

        const objectResult =
          await env.DB.prepare(`
            SELECT
              id,
              object_code,
              name
            FROM objects
            WHERE object_code = ?
            LIMIT 1
          `).bind(objectCode).all();

        if (
          !objectResult.results ||
          !objectResult.results.length
        ) {
          return json({
            ok: false,
            error: "Об'єкт не знайдено"
          }, cors, 404);
        }

        const object =
          objectResult.results[0];

        const filesResult =
          await env.DB.prepare(`
            SELECT
              id,
              object_id,
              name,
              file_type,
              storage_key,
              version,
              uploaded_by,
              created_at
            FROM files
            WHERE object_id = ?
            ORDER BY created_at DESC, id DESC
          `).bind(object.id).all();

        return json({
          ok: true,

          object: {
            id:
              object.id,

            object_code:
              object.object_code,

            name:
              object.name
          },

          files:
            filesResult.results || []
        }, cors);
      }


      // =========================================================
      // PATCH /object/:objectCode
      // Оновлення даних об'єкта
      // =========================================================

      if (
        request.method === "PATCH" &&
        path.startsWith("/object/")
      ) {

        const objectCode =
          decodeURIComponent(
            path
              .replace("/object/", "")
              .replace(/\/+$/, "")
          );

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            ok: false,
            error: "Некоректний JSON"
          }, cors, 400);
        }

        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body)
        ) {
          return json({
            ok: false,
            error: "Некоректні дані"
          }, cors, 400);
        }

        const objectResult =
          await env.DB.prepare(`
            SELECT *
            FROM objects
            WHERE object_code = ?
            LIMIT 1
          `).bind(objectCode).all();

        if (
          !objectResult.results ||
          !objectResult.results.length
        ) {
          return json({
            ok: false,
            error: "Об'єкт не знайдено"
          }, cors, 404);
        }

        const currentObject =
          objectResult.results[0];

        const fields = [];
        const values = [];
        const changedFields = [];

        if (
          Object.prototype.hasOwnProperty.call(
            body,
            "notes"
          )
        ) {

          fields.push("notes = ?");

          values.push(
            body.notes === null
              ? null
              : String(body.notes).trim() || null
          );

          changedFields.push("notes");
        }

        if (
          Object.prototype.hasOwnProperty.call(
            body,
            "planned_start_date"
          )
        ) {

          fields.push(
            "planned_start_date = ?"
          );

          values.push(
            body.planned_start_date === null
              ? null
              : String(body.planned_start_date).trim() || null
          );

          changedFields.push(
            "planned_start_date"
          );
        }

        if (
          Object.prototype.hasOwnProperty.call(
            body,
            "estimated_value"
          )
        ) {

          if (
            body.estimated_value !== null &&
            body.estimated_value !== "" &&
            !Number.isFinite(
              Number(body.estimated_value)
            )
          ) {
            return json({
              ok: false,
              error:
                "Некоректне значення estimated_value"
            }, cors, 400);
          }

          fields.push(
            "estimated_value = ?"
          );

          values.push(
            body.estimated_value === null ||
            body.estimated_value === ""
              ? null
              : Number(body.estimated_value)
          );

          changedFields.push(
            "estimated_value"
          );
        }

        if (
          Object.prototype.hasOwnProperty.call(
            body,
            "actual_value"
          )
        ) {

          if (
            body.actual_value !== null &&
            body.actual_value !== "" &&
            !Number.isFinite(
              Number(body.actual_value)
            )
          ) {
            return json({
              ok: false,
              error:
                "Некоректне значення actual_value"
            }, cors, 400);
          }

          fields.push(
            "actual_value = ?"
          );

          values.push(
            body.actual_value === null ||
            body.actual_value === ""
              ? null
              : Number(body.actual_value)
          );

          changedFields.push(
            "actual_value"
          );
        }

        if (
          Object.prototype.hasOwnProperty.call(
            body,
            "completed_at"
          )
        ) {

          fields.push(
            "completed_at = ?"
          );

          values.push(
            body.completed_at === null
              ? null
              : String(body.completed_at).trim() || null
          );

          changedFields.push(
            "completed_at"
          );
        }

        if (!fields.length) {
          return json({
            ok: false,
            error: "Немає даних для оновлення"
          }, cors, 400);
        }

        fields.push(
          "updated_at = CURRENT_TIMESTAMP"
        );

        const updateResult =
          await env.DB.prepare(`
            UPDATE objects
            SET ${fields.join(", ")}
            WHERE id = ?
          `).bind(
            ...values,
            currentObject.id
          ).run();

        if (
          updateResult.meta &&
          updateResult.meta.changes !== 1
        ) {
          return json({
            ok: false,
            error: "Об'єкт не було оновлено"
          }, cors, 500);
        }

        await env.DB.prepare(`
          INSERT INTO events (
            object_id,
            request_id,
            event_type,
            content,
            author_type
          )
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          currentObject.id,
          null,
          "object_updated",
          `Оновлено: ${changedFields.join(", ")}`,
          "system"
        ).run();

        const updatedResult =
          await env.DB.prepare(`
            SELECT
              o.*,
              c.id AS client_id,
              c.name AS client_name,
              c.phone AS client_phone
            FROM objects o
            LEFT JOIN clients c
              ON c.id = o.client_id
            WHERE o.id = ?
            LIMIT 1
          `).bind(currentObject.id).all();

        const object =
          updatedResult.results?.[0] || null;

        if (object) {
          object.status_label =
            STATUS_LABELS[object.status] ||
            object.status ||
            "Невідомо";
        }

        return json({
          ok: true,
          object,

          event: {
            event_type: "object_updated",
            changed_fields: changedFields,
            author_type: "system"
          }
        }, cors);
      }


      // =========================================================
      // GET /object/:objectCode
      // Повна картка об'єкта
      // =========================================================

      if (
        request.method === "GET" &&
        path.startsWith("/object/")
      ) {

        const objectCode =
          decodeURIComponent(
            path
              .replace("/object/", "")
              .replace(/\/+$/, "")
          );

        const objectResult =
          await env.DB.prepare(`
            SELECT
              o.*,
              c.id AS client_id,
              c.name AS client_name,
              c.phone AS client_phone
            FROM objects o
            LEFT JOIN clients c
              ON c.id = o.client_id
            WHERE o.object_code = ?
            LIMIT 1
          `).bind(objectCode).all();

        if (
          !objectResult.results ||
          !objectResult.results.length
        ) {
          return json({
            ok: false,
            error: "Об'єкт не знайдено"
          }, cors, 404);
        }

        const objectData =
          objectResult.results[0];

        const requestsResult =
          await env.DB.prepare(`
            SELECT
              r.id,
              r.request_code,
              r.type,
              r.type_label,
              r.name,
              r.phone,
              r.location,
              r.timing,
              r.project,
              r.consultation_date,
              r.source,
              r.status,
              r.created_at,
              r.updated_at
            FROM requests r
            WHERE r.object_id = ?
            ORDER BY r.id DESC
          `).bind(objectData.id).all();

        const requests =
          (requestsResult.results || []).map(r => ({
            ...r,

            status_label:
              STATUS_LABELS[r.status] ||
              r.status ||
              "Невідомо"
          }));

        const eventsResult =
          await env.DB.prepare(`
            SELECT
              id,
              request_id,
              object_id,
              event_type,
              content,
              author_type,
              author_id,
              created_at
            FROM events
            WHERE object_id = ?
            ORDER BY id ASC
          `).bind(objectData.id).all();

        const events =
          eventsResult.results || [];

        return json({
          ok: true,

          object: {
            ...objectData,

            status_label:
              STATUS_LABELS[objectData.status] ||
              objectData.status ||
              "Невідомо"
          },

          client: objectData.client_id
            ? {
                id:
                  objectData.client_id,

                name:
                  objectData.client_name,

                phone:
                  objectData.client_phone
              }
            : null,

          requests,
          events
        }, cors);
      }


      // =========================================================
      // POST /
      // Створення нової заявки
      // =========================================================

      if (
        request.method === "POST" &&
        path === "/"
      ) {

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            ok: false,
            error: "Некоректний JSON"
          }, cors, 400);
        }

        const name =
          String(body.name || "").trim();

        const phone =
          String(body.phone || "").trim();

        const type =
          String(body.type || "").trim();

        const typeLabel =
          String(body.typeLabel || "").trim();

        const location =
          String(body.location || "").trim();

        const timing =
          String(body.timing || "").trim();

        const project =
          String(body.project || "").trim();

        const consultationDate =
          String(body.consultationDate || "").trim();

        const source =
          String(
            body.source ||
            "SA-MASTER.PRO"
          ).trim();

        if (!name || !phone || !type) {
          return json({
            ok: false,
            error:
              "Необхідні ім'я, телефон та тип заявки"
          }, cors, 400);
        }

        const countResult =
          await env.DB.prepare(`
            SELECT COUNT(*) AS count
            FROM requests
            WHERE request_code LIKE 'SM-R-2026-%'
          `).all();

        const count =
          Number(
            countResult.results?.[0]?.count || 0
          ) + 1;

        const requestCode =
          `SM-R-2026-${String(count).padStart(3, "0")}`;

        const insertResult =
          await env.DB.prepare(`
            INSERT INTO requests (
              request_code,
              type,
              type_label,
              name,
              phone,
              location,
              timing,
              project,
              consultation_date,
              source,
              status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            requestCode,
            type,
            typeLabel,
            name,
            phone,
            location || null,
            timing || null,
            project || null,
            consultationDate || null,
            source,
            "new"
          ).run();

        if (!insertResult.meta?.last_row_id) {
          return json({
            ok: false,
            error: "Не вдалося створити заявку"
          }, cors, 500);
        }

        const requestId =
          insertResult.meta.last_row_id;

        const normalizedPhone =
          normalizePhone(phone);

        const clientResult =
          await env.DB.prepare(`
            SELECT *
            FROM clients
            WHERE phone = ?
            LIMIT 1
          `).bind(normalizedPhone).all();

        let client;

        if (
          clientResult.results &&
          clientResult.results.length
        ) {

          client =
            clientResult.results[0];

        } else {

          const clientInsert =
            await env.DB.prepare(`
              INSERT INTO clients (
                name,
                phone
              )
              VALUES (?, ?)
            `).bind(
              name,
              normalizedPhone
            ).run();

          if (clientInsert.meta?.last_row_id) {

            const createdClient =
              await env.DB.prepare(`
                SELECT *
                FROM clients
                WHERE id = ?
                LIMIT 1
              `).bind(
                clientInsert.meta.last_row_id
              ).all();

            client =
              createdClient.results?.[0] ||
              null;
          }
        }

        if (client) {

          await env.DB.prepare(`
            UPDATE requests
            SET client_id = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            client.id,
            requestId
          ).run();
        }

        await env.DB.prepare(`
          INSERT INTO events (
            object_id,
            request_id,
            event_type,
            content,
            author_type
          )
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          null,
          requestId,
          "request_created",
          "Створено заявку",
          "system"
        ).run();

        const telegramText = [
          "🏠 НОВА ЗАЯВКА",
          `🆔 ID: ${requestCode}`,
          `👤 Ім'я: ${name}`,
          `📞 Телефон: ${phone}`,
          `🔧 Тип: ${typeLabel || type}`,
          `📍 Об'єкт: ${location || "—"}`,
          `📐 Дизайн-проєкт: ${project || "—"}`,
          `🗓 Початок: ${timing || "—"}`,
          `📅 Консультація: ${consultationDate || "—"}`,
          `🔗 Джерело: ${source}`,
          `📊 Статус: ${STATUS_LABELS.new}`,
          `🕐 Час: ${new Date().toLocaleString(
            "uk-UA",
            {
              timeZone: "Europe/Kyiv"
            }
          )}`
        ].join("\n");

        if (
          env.BOT_TOKEN &&
          env.CHAT_ID
        ) {

          try {

            await fetch(
              `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    "application/json"
                },

                body: JSON.stringify({
                  chat_id:
                    env.CHAT_ID,

                  text:
                    telegramText
                })
              }
            );

          } catch (telegramError) {

            console.error(
              "Telegram error:",
              telegramError
            );
          }
        }

        return json({
          ok: true,

          request: {
            id:
              requestId,

            request_code:
              requestCode,

            client_id:
              client?.id || null,

            status:
              "new",

            status_label:
              STATUS_LABELS.new
          }
        }, cors);
      }


      // =========================================================
      // 404
      // =========================================================

      return json({
        ok: false,
        error: "Not found"
      }, cors, 404);


    } catch (error) {

      console.error(error);

      return json({
        ok: false,

        error:
          error?.message ||
          String(error)

      }, cors, 500);
    }
  }
};


// =============================================================
// Helpers
// =============================================================

function json(
  data,
  cors,
  status = 200
) {

  return new Response(
    JSON.stringify(data),

    {
      status,

      headers: {
        ...cors,

        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}


function normalizePhone(phone) {

  return String(phone || "")
    .replace(/[^\d+]/g, "");
}
