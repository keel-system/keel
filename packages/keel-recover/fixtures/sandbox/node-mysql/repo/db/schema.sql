-- El esquema del legacy de fixture con MySQL, con los datos que ya tenía la base: la app no lo crea (como
-- show-ticketing, ST-ENV-06), lo carga la base al iniciarse. Lleva lo que MySQL tiene y PostgreSQL no, y que
-- keel-recover tiene que leer sin perderlo (PLAN-KEEL-RECOVER-MYSQL.md, M2):
--
--   - el ciclo de vida en un ENUM de columna, y un CHECK (se aplica desde 8.0.16; antes se ignoraba);
--   - la UNIQUE de sku sobre una collation _ci: «A» y «a» son el mismo artículo;
--   - updated_at, un TIMESTAMP con ON UPDATE CURRENT_TIMESTAMP: cambia sin que el flujo lo toque (M-09),
--     y la base corre en otra zona horaria (-05:00, en compose.yaml), así que su valor depende de la sesión;
--   - fechas cero (0000-00-00) como «sin fecha», que el sql_mode viejo del servidor admite (compose.yaml);
--   - una tabla MyISAM rellenada por un trigger (M-10 y M-11): sin transacciones, y su clave ajena declarada
--     no se aplica.

create table items (
  id int not null auto_increment primary key,
  sku varchar(64) collate utf8mb4_0900_ai_ci not null unique,
  quantity json not null,
  status enum('AVAILABLE', 'SOLD') not null default 'AVAILABLE',
  last_sold_at datetime not null default '0000-00-00 00:00:00',
  restock_on date not null default '0000-00-00',
  updated_at timestamp not null default current_timestamp on update current_timestamp
) engine = InnoDB;

create table movements (
  id int not null auto_increment primary key,
  item_id int not null,
  delta int not null,
  constraint movements_delta_nonzero check (delta <> 0),
  constraint movements_item_fk foreign key (item_id) references items (id) on delete cascade
) engine = InnoDB;

create table movement_log (
  id int not null auto_increment primary key,
  movement_id int not null,
  delta int not null,
  foreign key (movement_id) references movements (id)
) engine = MyISAM;

create trigger movement_logged after insert on movements
  for each row insert into movement_log (movement_id, delta) values (new.id, new.delta);

insert into items (sku, quantity) values ('seed-1', '5');
insert into items (sku, quantity, status, last_sold_at, restock_on, updated_at)
  values ('seed-2', '0', 'SOLD', '2024-03-01 10:00:00', '2024-04-01', '2024-03-01 10:00:00');
insert into movements (item_id, delta) values (1, 5), (2, 3), (2, -3);
